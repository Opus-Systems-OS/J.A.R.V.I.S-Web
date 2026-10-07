//! `/bff/v1/*` → the Opus Systems OS API with this site's own key. The page
//! never sees a key; it sees an unlocked cookie, and this passthrough adds
//! the `Authorization` header on the way out.
//!
//! Only an allowlist of API areas is reachable, and key management and
//! pairing never are — whatever scopes the `web` key happens to hold. Bodies
//! stream both ways, so the session SSE feed passes through as it arrives.
//!
//! Each profile calls upstream with its own key. Mr. Powers's is limited to
//! his own agent by the API itself; here he also gets a narrower set of
//! areas (no ops, sources, briefing, clients, rig or credit), so a panel
//! he doesn't have is a 404 before anything leaves this box.
//!
//! An agent's output file is served from this origin, so it always goes out
//! as an attachment under a sandboxing CSP: an `.html` or `.svg` an agent
//! wrote (perhaps steered by a page it read) can never run as this site.
//!
//! `/bff/v1/keys` and `/bff/v1/pair` themselves are honeypot traps
//! (`honey.rs`); deeper uses of those segments are a plain 404 here.

use crate::config::Profile;
use crate::error::{Error, Result};
use crate::request_id::{RequestId, HEADER as REQUEST_ID};
use crate::AppState;
use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderName, HeaderValue};
use axum::response::Response;
use axum::Extension;
use futures_util::TryStreamExt;
use secrecy::ExposeSecret;

/// First path segment → reachable. Everything else is a 404 here.
const ALLOWED_AREAS: &[&str] = &[
    "me", "fleet", "rig", "sessions", "usage", "voice", "ops", "sources", "briefing", "clients",
    "files",
];
/// A profile that isn't the owner's reaches only these.
const LIMITED_AREAS: &[&str] = &["me", "sessions", "files", "fleet", "usage", "voice"];
/// …and never these (the Fish balance is the owner's ledger).
const LIMITED_DENIED: &[&str] = &["/v1/voice/credit"];
/// Never reachable, at any depth.
const FORBIDDEN_SEGMENTS: &[&str] = &["keys", "pair"];
/// Request bodies are small JSON (events, tool results, text to speak)…
const MAX_REQUEST_BYTES: usize = 1 << 20;
/// …except a file attached in the chat (`POST files`): the API's 32 MB per
/// file plus multipart framing.
const MAX_UPLOAD_BYTES: usize = 32 * 1024 * 1024 + 64 * 1024;

fn body_limit(api_path: &str) -> usize {
    if api_path == "/v1/files" {
        MAX_UPLOAD_BYTES
    } else {
        MAX_REQUEST_BYTES
    }
}

const FORWARD_REQUEST: &[HeaderName] = &[header::CONTENT_TYPE, header::ACCEPT];
const FORWARD_RESPONSE: &[HeaderName] = &[
    header::CONTENT_TYPE,
    // An agent's output file downloads under its own name.
    header::CONTENT_DISPOSITION,
    header::CACHE_CONTROL,
    header::RETRY_AFTER,
];

/// What an agent's output file is served under, whatever the API said.
const DOWNLOAD_CSP: &str = "sandbox; default-src 'none'";

/// `GET /v1/files/{id}/content`: a file's bytes.
fn is_file_content(api_path: &str) -> bool {
    api_path
        .strip_prefix("/v1/files/")
        .and_then(|p| p.strip_suffix("/content"))
        .is_some_and(|id| !id.is_empty() && !id.contains('/'))
}

/// `attachment`, keeping the upstream parameters (the filename) — never
/// `inline`, never absent.
pub fn force_attachment(upstream: Option<&HeaderValue>) -> HeaderValue {
    let params = upstream
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split_once(';'))
        .map(|(_, rest)| rest.trim())
        .unwrap_or("");
    if params.is_empty() {
        return HeaderValue::from_static("attachment");
    }
    HeaderValue::from_str(&format!("attachment; {params}"))
        .unwrap_or(HeaderValue::from_static("attachment"))
}

fn segment_ok(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

/// The API path for `rest` (what follows `/bff/v1/`), or `None` when it may
/// not be proxied.
pub fn allowed_path(rest: &str) -> Option<String> {
    let segments: Vec<&str> = rest.split('/').collect();
    let first = *segments.first()?;
    if !ALLOWED_AREAS.contains(&first) {
        return None;
    }
    if segments
        .iter()
        .any(|s| !segment_ok(s) || FORBIDDEN_SEGMENTS.contains(s))
    {
        return None;
    }
    Some(format!("/v1/{}", segments.join("/")))
}

/// Whether `profile` may reach the API path `path` (already allowlisted).
pub fn profile_allows(profile: &Profile, path: &str) -> bool {
    if profile.full {
        return true;
    }
    let area = path
        .strip_prefix("/v1/")
        .and_then(|p| p.split('/').next())
        .unwrap_or("");
    LIMITED_AREAS.contains(&area) && !LIMITED_DENIED.contains(&path)
}

pub async fn proxy(
    State(state): State<AppState>,
    Extension(profile): Extension<Profile>,
    Extension(RequestId(request_id)): Extension<RequestId>,
    Path(rest): Path<String>,
    req: Request,
) -> Result<Response> {
    let path = allowed_path(&rest)
        .filter(|p| profile_allows(&profile, p))
        .ok_or(Error::NotFound)?;
    let (parts, body) = req.into_parts();
    let mut url = format!("{}{}", state.config.api_url, path);
    if let Some(q) = parts.uri.query() {
        url.push('?');
        url.push_str(q);
    }

    let body = axum::body::to_bytes(body, body_limit(&path))
        .await
        .map_err(|_| Error::InvalidRequest("request body too large".to_owned()))?;

    let mut out = state
        .http
        .request(parts.method.clone(), &url)
        .bearer_auth(profile.api_key.expose_secret())
        .header(REQUEST_ID, &request_id);
    for name in FORWARD_REQUEST {
        if let Some(v) = parts.headers.get(name) {
            out = out.header(name, v);
        }
    }
    if let Some(v) = parts.headers.get("last-event-id") {
        out = out.header("last-event-id", v);
    }
    if !body.is_empty() {
        out = out.body(body);
    }

    let upstream = out.send().await?;
    let download = is_file_content(&path) && upstream.status().is_success();
    let mut res = Response::builder().status(upstream.status().as_u16());
    for name in FORWARD_RESPONSE {
        if download && name == header::CONTENT_DISPOSITION {
            continue;
        }
        if let Some(v) = upstream.headers().get(name) {
            res = res.header(name, v);
        }
    }
    if download {
        res = res
            .header(
                header::CONTENT_DISPOSITION,
                force_attachment(upstream.headers().get(header::CONTENT_DISPOSITION)),
            )
            .header(header::CONTENT_SECURITY_POLICY, DOWNLOAD_CSP);
    }
    // Event streams must not be buffered by Caddy or anything else.
    let is_sse = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.starts_with("text/event-stream"));
    if is_sse {
        res = res.header("x-accel-buffering", "no");
    }
    let stream = upstream.bytes_stream().map_err(std::io::Error::other);
    res.body(Body::from_stream(stream))
        .map_err(|e| Error::Internal(format!("response: {e}")))
}

#[cfg(test)]
mod tests {
    use super::allowed_path;

    #[test]
    fn a_limited_profile_reaches_only_its_areas() {
        let p = |full| crate::config::Profile {
            id: "x".into(),
            name: "X".into(),
            password_hash: String::new(),
            api_key: String::new().into(),
            full,
        };
        let (owner, limited) = (p(true), p(false));
        for path in [
            "/v1/me",
            "/v1/sessions",
            "/v1/sessions/sesn_1/stream",
            "/v1/files/file_1/content",
            "/v1/fleet/agents",
            "/v1/usage",
            "/v1/voice/speak",
            "/v1/voice/transcribe",
        ] {
            assert!(super::profile_allows(&limited, path), "{path}");
        }
        for path in [
            "/v1/ops",
            "/v1/sources",
            "/v1/briefing",
            "/v1/clients",
            "/v1/rig",
            "/v1/voice/credit",
        ] {
            assert!(!super::profile_allows(&limited, path), "{path}");
            assert!(super::profile_allows(&owner, path), "{path}");
        }
    }

    #[test]
    fn downloads_are_always_attachments() {
        use super::{force_attachment, is_file_content};
        use axum::http::HeaderValue;
        assert!(is_file_content("/v1/files/file_1/content"));
        assert!(!is_file_content("/v1/files"));
        assert!(!is_file_content("/v1/files//content"));
        let v = |s: &'static str| HeaderValue::from_static(s);
        assert_eq!(force_attachment(None), "attachment");
        assert_eq!(force_attachment(Some(&v("inline"))), "attachment");
        assert_eq!(
            force_attachment(Some(&v("inline; filename=\"x.html\""))),
            "attachment; filename=\"x.html\""
        );
        assert_eq!(
            force_attachment(Some(&v("attachment; filename=\"summary.md\""))),
            "attachment; filename=\"summary.md\""
        );
    }

    #[test]
    fn allowlist() {
        assert_eq!(allowed_path("me").as_deref(), Some("/v1/me"));
        assert_eq!(
            allowed_path("sessions/sesn_01ABC/stream").as_deref(),
            Some("/v1/sessions/sesn_01ABC/stream")
        );
        assert_eq!(
            allowed_path("voice/speak").as_deref(),
            Some("/v1/voice/speak")
        );
        assert_eq!(allowed_path("files").as_deref(), Some("/v1/files"));
        assert_eq!(
            allowed_path("files/file_011CN/content").as_deref(),
            Some("/v1/files/file_011CN/content")
        );
        assert_eq!(super::body_limit("/v1/files"), super::MAX_UPLOAD_BYTES);
        assert_eq!(
            super::body_limit("/v1/sessions/sesn_1/events"),
            super::MAX_REQUEST_BYTES
        );
        for denied in [
            "keys",
            "keys/abc",
            "pair",
            "pair/123/approve",
            "sessions/pair",
            "fleet/../keys",
            "fleet/./agents",
            "fleet//agents",
            "",
            "openapi.json",
            "docs",
            "health",
            "fleet/%2e%2e",
        ] {
            assert_eq!(allowed_path(denied), None, "{denied}");
        }
    }
}
