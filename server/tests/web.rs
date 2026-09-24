//! Stage 1 contract: the unlock, its limits and cookie, the `/bff` allowlist
//! and passthrough (SSE included), CSRF, and the static shell's headers.
//! Everything goes through the real router with an in-memory DB; the Opus
//! Systems OS API is a stub axum server on a random port.

use axum::body::Body;
use axum::extract::Request as AxumRequest;
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{any, get};
use axum::Router;
use futures_util::StreamExt;
use http_body_util::BodyExt;
use jarvis_web::config::Config;
use jarvis_web::{app, auth, db::Db, AppState};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tower::ServiceExt;

const PASSWORD: &str = "correct horse battery staple";
const WEB_KEY: &str = "osk_webtest0_secret";

fn password_hash() -> String {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| auth::hash_password(PASSWORD).unwrap())
        .clone()
}

/// What the stub API saw: (method, path+query, authorization, body).
type Seen = Arc<Mutex<Vec<(String, String, String, String)>>>;

/// What the stub's `/v1/usage` and `/v1/voice/credit` answer; tests set it.
#[derive(Clone)]
struct Knobs {
    usage: Arc<Mutex<Value>>,
    /// `None` = Fish is failing (the API's 502).
    credit: Arc<Mutex<Option<Value>>>,
}

impl Default for Knobs {
    fn default() -> Self {
        Knobs {
            usage: Arc::new(Mutex::new(
                json!({"window": {}, "by_agent": [], "recent": []}),
            )),
            credit: Arc::new(Mutex::new(Some(
                json!({"credit_usd": "12.34", "checked_at": "2026-09-24T00:00:00Z"}),
            ))),
        }
    }
}

struct Harness {
    app: Router,
    seen: Seen,
    knobs: Knobs,
    _static_dir: tempdir::Dir,
}

mod tempdir {
    pub struct Dir(pub std::path::PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    pub fn new() -> Dir {
        let p = std::env::temp_dir().join(format!(
            "jarvis-web-test-{}",
            jarvis_web::hex(&jarvis_web::random_bytes::<8>())
        ));
        std::fs::create_dir_all(p.join("assets")).unwrap();
        std::fs::write(
            p.join("index.html"),
            "<!doctype html><title>J.A.R.V.I.S.</title>",
        )
        .unwrap();
        std::fs::write(p.join("assets/app-abc123.js"), "console.log(1)").unwrap();
        Dir(p)
    }
}

async fn stub_api(seen: Seen, knobs: Knobs) -> String {
    async fn record(seen: &Seen, req: AxumRequest) -> (String, HeaderMap) {
        let (parts, body) = req.into_parts();
        let body = String::from_utf8(body.collect().await.unwrap().to_bytes().to_vec()).unwrap();
        let auth = parts
            .headers
            .get(header::AUTHORIZATION)
            .map(|v| v.to_str().unwrap().to_owned())
            .unwrap_or_default();
        let pq = parts.uri.path_and_query().unwrap().to_string();
        seen.lock()
            .unwrap()
            .push((parts.method.to_string(), pq.clone(), auth, body.clone()));
        (body, parts.headers)
    }

    let s1 = seen.clone();
    let s2 = seen.clone();
    let s3 = seen.clone();
    let s4 = seen.clone();
    let s5 = seen.clone();
    let k4 = knobs.clone();
    let k5 = knobs;
    let router = Router::new()
        .route(
            "/v1/usage",
            get(move |req: AxumRequest| async move {
                record(&s4, req).await;
                axum::Json(k4.usage.lock().unwrap().clone())
            }),
        )
        .route(
            "/v1/voice/credit",
            get(move |req: AxumRequest| async move {
                record(&s5, req).await;
                match k5.credit.lock().unwrap().clone() {
                    Some(v) => axum::Json(v).into_response(),
                    None => (
                        StatusCode::BAD_GATEWAY,
                        axum::Json(json!({"error": {"type": "upstream", "message": "voice credits are exhausted", "request_id": "req_up"}})),
                    )
                        .into_response(),
                }
            }),
        )
        .route(
            "/v1/me",
            get(move |req: AxumRequest| async move {
                record(&s1, req).await;
                axum::Json(json!({"key_id": "webtest0", "name": "web"}))
            }),
        )
        .route(
            "/v1/sessions/{id}/stream",
            get(move |req: AxumRequest| async move {
                record(&s2, req).await;
                let chunks = futures_util::stream::iter(["event: a\ndata: 1\n\n", "event: b\ndata: 2\n\n"])
                    .then(|c| async move {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        Ok::<_, std::io::Error>(c)
                    });
                (
                    [(header::CONTENT_TYPE, "text/event-stream")],
                    Body::from_stream(chunks),
                )
                    .into_response()
            }),
        )
        .route(
            "/v1/{*rest}",
            any(move |req: AxumRequest| async move {
                let (body, headers) = record(&s3, req).await;
                if body.contains("boom") {
                    return (
                        StatusCode::TOO_MANY_REQUESTS,
                        [(header::RETRY_AFTER, "7")],
                        axum::Json(json!({"error": {"type": "rate_limited", "message": "slow down", "request_id": "req_up"}})),
                    )
                        .into_response();
                }
                axum::Json(json!({
                    "echo": body,
                    "content_type": headers.get(header::CONTENT_TYPE).map(|v| v.to_str().unwrap().to_owned()),
                    "request_id": headers.get("x-request-id").map(|v| v.to_str().unwrap().to_owned()),
                    "cookie": headers.get(header::COOKIE).is_some(),
                }))
                .into_response()
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}")
}

async fn harness() -> Harness {
    let seen: Seen = Arc::default();
    let knobs = Knobs::default();
    let api_url = stub_api(seen.clone(), knobs.clone()).await;
    let dir = tempdir::new();
    let config = Config {
        port: 0,
        database_path: "unused".into(),
        api_url,
        api_key: WEB_KEY.to_owned(),
        password_hash: password_hash(),
        static_dir: Some(dir.0.clone()),
        session_hours: 12,
    };
    let state = AppState::new(config, Db::in_memory().unwrap()).unwrap();
    Harness {
        app: app(state),
        seen,
        knobs,
        _static_dir: dir,
    }
}

struct Resp {
    status: StatusCode,
    headers: HeaderMap,
    body: Vec<u8>,
}

impl Resp {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

async fn send(h: &Harness, req: Request<Body>) -> Resp {
    let res = h.app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    Resp {
        status,
        headers,
        body,
    }
}

fn login_req(password: &str, ip: &str) -> Request<Body> {
    Request::builder()
        .method(Method::POST)
        .uri("/auth/login")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-jarvis", "1")
        .header("x-forwarded-for", ip)
        .body(Body::from(json!({ "password": password }).to_string()))
        .unwrap()
}

/// Unlock and return the `Cookie` header value to send back.
async fn unlock(h: &Harness) -> String {
    let r = send(h, login_req(PASSWORD, "203.0.113.9")).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let set = r.headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    set.split(';').next().unwrap().to_owned()
}

fn bff(method: Method, path: &str, cookie: Option<&str>, body: Option<Value>) -> Request<Body> {
    let mut b = Request::builder()
        .method(method)
        .uri(path)
        .header("x-jarvis", "1");
    if let Some(c) = cookie {
        b = b.header(header::COOKIE, c);
    }
    match body {
        Some(v) => b
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(v.to_string()))
            .unwrap(),
        None => b.body(Body::empty()).unwrap(),
    }
}

fn assert_envelope(json: &Value, kind: &str) {
    assert_eq!(json["error"]["type"], kind, "{json}");
    assert!(json["error"]["message"].is_string(), "{json}");
    assert!(
        json["error"]["request_id"]
            .as_str()
            .is_some_and(|s| !s.is_empty()),
        "{json}"
    );
}

#[tokio::test]
async fn right_password_unlocks_with_a_locked_down_cookie() {
    let h = harness().await;
    let r = send(&h, login_req(PASSWORD, "203.0.113.1")).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let cookie = r.headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    assert!(cookie.starts_with("__Host-jw="), "{cookie}");
    for attr in [
        "Path=/",
        "HttpOnly",
        "Secure",
        "SameSite=Strict",
        "Max-Age=43200",
    ] {
        assert!(cookie.contains(attr), "{cookie} lacks {attr}");
    }
    assert!(
        !cookie.contains("Domain="),
        "__Host- cookies carry no Domain"
    );
}

#[tokio::test]
async fn wrong_password_is_401_then_429_after_five() {
    let h = harness().await;
    for _ in 0..5 {
        let r = send(&h, login_req("nope", "198.51.100.7")).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED);
        assert_envelope(&r.json(), "unauthorized");
    }
    // Sixth attempt is refused before any hashing — even with the right one.
    let r = send(&h, login_req(PASSWORD, "198.51.100.7")).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_envelope(&r.json(), "rate_limited");
    let retry: u32 = r.headers[header::RETRY_AFTER]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=900).contains(&retry), "{retry}");

    // Another address is unaffected.
    let r = send(&h, login_req(PASSWORD, "198.51.100.8")).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn login_rejects_unknown_fields_and_needs_the_csrf_header() {
    let h = harness().await;
    let r = send(
        &h,
        Request::builder()
            .method(Method::POST)
            .uri("/auth/login")
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-jarvis", "1")
            .body(Body::from(
                json!({"password": PASSWORD, "remember": true}).to_string(),
            ))
            .unwrap(),
    )
    .await;
    assert!(r.status.is_client_error());
    assert_envelope(&r.json(), "invalid_request");

    let r = send(
        &h,
        Request::builder()
            .method(Method::POST)
            .uri("/auth/login")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({"password": PASSWORD}).to_string()))
            .unwrap(),
    )
    .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    assert_envelope(&r.json(), "forbidden");
}

#[tokio::test]
async fn bff_needs_an_unlocked_session() {
    let h = harness().await;
    let r = send(&h, bff(Method::GET, "/bff/v1/me", None, None)).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_envelope(&r.json(), "unauthorized");

    let forged = format!("__Host-jw={}", "a".repeat(64));
    let r = send(&h, bff(Method::GET, "/bff/v1/me", Some(&forged), None)).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert!(h.seen.lock().unwrap().is_empty(), "nothing reached the API");
}

#[tokio::test]
async fn bff_adds_the_key_and_passes_through() {
    let h = harness().await;
    let cookie = unlock(&h).await;

    let r = send(&h, bff(Method::GET, "/bff/v1/me", Some(&cookie), None)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["name"], "web");

    let r = send(
        &h,
        bff(
            Method::POST,
            "/bff/v1/sessions/sesn_1/events?x=1",
            Some(&cookie),
            Some(json!({"text": "hello"})),
        ),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    let j = r.json();
    assert_eq!(j["echo"], r#"{"text":"hello"}"#);
    assert_eq!(j["content_type"], "application/json");
    assert_eq!(j["cookie"], false, "the browser cookie never goes upstream");
    let our_id = r.headers["x-request-id"].to_str().unwrap();
    assert_eq!(j["request_id"], our_id, "one request id end to end");

    let seen = h.seen.lock().unwrap();
    assert!(seen
        .iter()
        .all(|(_, _, auth, _)| auth == &format!("Bearer {WEB_KEY}")));
    assert!(seen
        .iter()
        .any(|(m, pq, _, _)| m == "POST" && pq == "/v1/sessions/sesn_1/events?x=1"));
}

#[tokio::test]
async fn bff_never_reaches_keys_or_pairing() {
    let h = harness().await;
    let cookie = unlock(&h).await;
    for path in [
        "/bff/v1/keys",
        "/bff/v1/keys/abc",
        "/bff/v1/pair",
        "/bff/v1/pair/123456/approve",
        "/bff/v1/openapi.json",
        "/bff/v1/fleet/../keys",
    ] {
        let r = send(&h, bff(Method::POST, path, Some(&cookie), Some(json!({})))).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{path}");
    }
    assert!(h.seen.lock().unwrap().is_empty(), "nothing reached the API");
}

#[tokio::test]
async fn bff_keeps_the_apis_error_envelope_and_retry_after() {
    let h = harness().await;
    let cookie = unlock(&h).await;
    let r = send(
        &h,
        bff(
            Method::POST,
            "/bff/v1/voice/speak",
            Some(&cookie),
            Some(json!({"text": "boom"})),
        ),
    )
    .await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(r.headers[header::RETRY_AFTER], "7");
    assert_eq!(r.json()["error"]["message"], "slow down");
}

#[tokio::test]
async fn bff_streams_sse() {
    let h = harness().await;
    let cookie = unlock(&h).await;
    let res = h
        .app
        .clone()
        .oneshot(bff(
            Method::GET,
            "/bff/v1/sessions/sesn_1/stream",
            Some(&cookie),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()[header::CONTENT_TYPE], "text/event-stream");
    assert_eq!(res.headers()["x-accel-buffering"], "no");
    let mut frames = res.into_body().into_data_stream();
    let first = frames.next().await.unwrap().unwrap();
    assert_eq!(
        &first[..],
        b"event: a\ndata: 1\n\n",
        "first frame before the stream ends"
    );
    let rest: Vec<u8> = frames
        .fold(Vec::new(), |mut acc, c| async move {
            acc.extend_from_slice(&c.unwrap());
            acc
        })
        .await;
    assert_eq!(rest, b"event: b\ndata: 2\n\n");
}

#[tokio::test]
async fn logout_ends_the_session() {
    let h = harness().await;
    let cookie = unlock(&h).await;
    let r = send(&h, bff(Method::POST, "/auth/logout", Some(&cookie), None)).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert!(r.headers[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .contains("Max-Age=0"));
    let r = send(&h, bff(Method::GET, "/bff/v1/me", Some(&cookie), None)).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn shell_and_assets_carry_the_right_headers() {
    let h = harness().await;
    let get = |uri: &str| Request::builder().uri(uri).body(Body::empty()).unwrap();

    let r = send(&h, get("/")).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.headers[header::CACHE_CONTROL], "no-store");
    let csp = r.headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
    assert!(csp.contains("default-src 'self'") && csp.contains("frame-ancestors 'none'"));
    assert_eq!(r.headers[header::X_FRAME_OPTIONS], "DENY");
    assert!(r.headers["permissions-policy"]
        .to_str()
        .unwrap()
        .contains("microphone=(self)"));

    // Unknown paths get the shell (client-side tabs), not a 404.
    let r = send(&h, get("/usage")).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(String::from_utf8_lossy(&r.body).contains("J.A.R.V.I.S."));

    let r = send(&h, get("/assets/app-abc123.js")).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.headers[header::CACHE_CONTROL]
        .to_str()
        .unwrap()
        .contains("immutable"));

    let r = send(&h, get("/healthz")).await;
    assert_eq!(r.status, StatusCode::OK);
}

#[tokio::test]
async fn one_hud_holds_the_mic() {
    let h = harness().await;
    let r = send(
        &h,
        bff(
            Method::POST,
            "/web/mic",
            None,
            Some(json!({"client": "tab-aaaa1111"})),
        ),
    )
    .await;
    assert_eq!(
        r.status,
        StatusCode::UNAUTHORIZED,
        "needs an unlocked session"
    );

    let cookie = unlock(&h).await;
    let claim = |client: &'static str, take: bool| {
        bff(
            Method::POST,
            "/web/mic",
            Some(&cookie),
            Some(json!({"client": client, "take": take})),
        )
    };
    assert_eq!(
        send(&h, claim("tab-aaaa1111", false)).await.json()["held"],
        true
    );
    assert_eq!(
        send(&h, claim("tab-bbbb2222", false)).await.json()["held"],
        false
    );
    assert_eq!(
        send(&h, claim("tab-bbbb2222", true)).await.json()["held"],
        true,
        "orb click takes over"
    );
    assert_eq!(
        send(&h, claim("tab-aaaa1111", false)).await.json()["held"],
        false
    );

    let r = send(&h, claim("bad client!", false)).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(
        h.seen.lock().unwrap().is_empty(),
        "the lease never touches the API"
    );
}

#[tokio::test]
async fn credits_need_an_unlock() {
    let h = harness().await;
    let r = send(&h, bff(Method::GET, "/web/credits", None, None)).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let r = send(
        &h,
        bff(
            Method::POST,
            "/web/credits",
            None,
            Some(json!({"anchor_cents": 900})),
        ),
    )
    .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert!(h.seen.lock().unwrap().is_empty(), "nothing reached the API");
}

#[tokio::test]
async fn credits_ledger_end_to_end() {
    let h = harness().await;
    let cookie = unlock(&h).await;

    // No anchor yet: Fish is read, Anthropic has no verdict.
    let r = send(&h, bff(Method::GET, "/web/credits", Some(&cookie), None)).await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let j = r.json();
    assert_eq!(j["anthropic"]["anchor_cents"], Value::Null);
    assert_eq!(j["anthropic"]["low"], false);
    assert_eq!(j["anthropic"]["estimate"], true);
    assert_eq!(j["anthropic"]["warn_below_cents"], 1000);
    assert_eq!(j["fish"]["credit_usd"], "12.34");
    assert_eq!(j["fish"]["low"], false);
    {
        let seen = h.seen.lock().unwrap();
        let usage = seen
            .iter()
            .find(|(_, p, _, _)| p.starts_with("/v1/usage"))
            .unwrap();
        assert_eq!(usage.1, "/v1/usage", "unwindowed without an anchor");
        assert_eq!(usage.2, format!("Bearer {WEB_KEY}"), "the site's own key");
    }

    // Anchor $9 with $1.50 spent since: $7.50 left, under the $10 line.
    *h.knobs.usage.lock().unwrap() = json!({"by_agent": [
        {"agent_slug": "jarvis", "session_count": 2, "total_list_cost_cents": 100, "budget_reached_count": 0},
        {"agent_slug": "gpu-compute", "session_count": 1, "total_list_cost_cents": 50, "budget_reached_count": 0}
    ], "recent": []});
    h.seen.lock().unwrap().clear();
    let r = send(
        &h,
        bff(
            Method::POST,
            "/web/credits",
            Some(&cookie),
            Some(json!({"anchor_cents": 900})),
        ),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{:?}", r.json());
    let j = r.json();
    assert_eq!(j["anthropic"]["anchor_cents"], 900);
    assert_eq!(j["anthropic"]["spent_since_cents"], 150);
    assert_eq!(j["anthropic"]["remaining_cents"], 750);
    assert_eq!(j["anthropic"]["low"], true);
    assert_eq!(j["anthropic"]["exhausted"], false);
    let anchored_at = j["anthropic"]["anchored_at"].as_str().unwrap().to_owned();
    {
        let seen = h.seen.lock().unwrap();
        let usage = seen
            .iter()
            .find(|(_, p, _, _)| p.starts_with("/v1/usage"))
            .unwrap();
        assert_eq!(
            usage.1,
            format!("/v1/usage?since={anchored_at}"),
            "windowed at the anchor"
        );
    }

    // The newest session died on billing: exhausted, until one runs again.
    *h.knobs.usage.lock().unwrap() = json!({"by_agent": [], "recent": [
        {"session_id": "sesn_b", "last_error": "billing_error: credit balance is too low", "observed_at": "2026-09-24T10:00:00Z"}
    ]});
    let j = send(&h, bff(Method::GET, "/web/credits", Some(&cookie), None))
        .await
        .json();
    assert_eq!(j["anthropic"]["exhausted"], true);
    assert_eq!(j["anthropic"]["billing_error_at"], "2026-09-24T10:00:00Z");

    // Thresholds are editable; Fish failing leaves the Anthropic half intact.
    *h.knobs.credit.lock().unwrap() = None;
    let r = send(
        &h,
        bff(
            Method::POST,
            "/web/credits",
            Some(&cookie),
            Some(json!({"anthropic_warn_cents": 500, "fish_warn_cents": 100})),
        ),
    )
    .await;
    let j = r.json();
    assert_eq!(j["anthropic"]["warn_below_cents"], 500);
    assert_eq!(j["anthropic"]["anchor_cents"], 900, "anchor untouched");
    assert_eq!(j["fish"]["warn_below_cents"], 100);
    assert_eq!(j["fish"]["error"], "voice credits are exhausted");
    assert_eq!(j["fish"]["credit_usd"], Value::Null);
}

#[tokio::test]
async fn credits_reject_bad_updates() {
    let h = harness().await;
    let cookie = unlock(&h).await;
    for bad in [
        json!({"anchor_cents": -1}),
        json!({"anchor_cents": 1_000_001}),
        json!({"anchor_cents": 9.5}),
        json!({"anchor_cents": "900"}),
        json!({"balance": 900}),
    ] {
        let r = send(
            &h,
            bff(
                Method::POST,
                "/web/credits",
                Some(&cookie),
                Some(bad.clone()),
            ),
        )
        .await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{bad}");
        assert_envelope(&r.json(), "invalid_request");
    }
    // Nothing was stored.
    let j = send(&h, bff(Method::GET, "/web/credits", Some(&cookie), None))
        .await
        .json();
    assert_eq!(j["anthropic"]["anchor_cents"], Value::Null);
}
