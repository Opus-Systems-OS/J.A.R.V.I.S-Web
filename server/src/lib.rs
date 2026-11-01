//! J.A.R.V.I.S. on the web: the password gate and backend-for-frontend at
//! `jarvis.opustower.dev`.
//!
//! ```text
//! browser ──> jarvis-web ──(/bff, own osk_ key)──> Opus Systems OS API ──> control plane ──> Managed Agents
//! ```
//!
//! It owns the unlock and nothing else of consequence: fleet state, sessions,
//! usage and voice are the API's, read live. The page it serves is a thin
//! client like every other Opus Systems client.

pub mod auth;
pub mod bff;
pub mod cams;
pub mod config;
pub mod credits;
pub mod db;
pub mod error;
pub mod honey;
pub mod intel;
pub mod layers;
pub mod local;
pub mod mic;
pub mod passkey;
pub mod projects;
pub mod reminders;
pub mod request_id;
pub mod route;
pub mod watches;

use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::middleware::{from_fn, from_fn_with_state};
use axum::routing::{any, get, post};
use axum::Router;
use config::Config;
use std::time::Duration;
use tower::limit::ConcurrencyLimitLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub db: db::Db,
    pub http: reqwest::Client,
    pub mic: std::sync::Arc<mic::Lease>,
    pub intel: std::sync::Arc<intel::Intel>,
    pub local: std::sync::Arc<local::Cache>,
    pub challenges: std::sync::Arc<passkey::Challenges>,
    /// Password checks allowed at once (`auth::verify`).
    pub verifying: std::sync::Arc<tokio::sync::Semaphore>,
}

impl AppState {
    pub fn new(config: Config, db: db::Db) -> error::Result<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::custom(|a| {
                if a.previous().len() < 5 && redirect_ok(a.url()) {
                    a.follow()
                } else {
                    a.stop()
                }
            }))
            .build()?;
        Ok(AppState {
            config,
            db,
            http,
            mic: std::sync::Arc::default(),
            intel: std::sync::Arc::default(),
            local: std::sync::Arc::default(),
            challenges: std::sync::Arc::default(),
            verifying: std::sync::Arc::new(tokio::sync::Semaphore::new(2)),
        })
    }
}

/// Content-Security-Policy for everything served: the page loads nothing
/// from anywhere but this origin, and talks to nothing but this origin.
/// Every DOM write of markup must go through the page's one Trusted Types
/// policy (`web/src/html.ts`, which escapes what it interpolates), so a
/// stray `innerHTML = untrusted` throws instead of running.
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; \
img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; \
worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'none'; \
form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests; \
require-trusted-types-for 'script'; trusted-types jarvis";

fn security_headers(router: Router) -> Router {
    let set = |name: HeaderName, value: &'static str| {
        SetResponseHeaderLayer::if_not_present(name, HeaderValue::from_static(value))
    };
    router
        .layer(set(header::CONTENT_SECURITY_POLICY, CSP))
        .layer(set(header::X_CONTENT_TYPE_OPTIONS, "nosniff"))
        .layer(set(header::X_FRAME_OPTIONS, "DENY"))
        .layer(set(header::REFERRER_POLICY, "no-referrer"))
        .layer(set(
            HeaderName::from_static("permissions-policy"),
            "microphone=(self), camera=(), geolocation=(self), payment=(), usb=()",
        ))
        .layer(set(
            header::STRICT_TRANSPORT_SECURITY,
            "max-age=31536000; includeSubDomains",
        ))
        // No window from another site keeps a handle on ours, and nothing
        // here may be embedded or read cross-origin.
        .layer(set(
            HeaderName::from_static("cross-origin-opener-policy"),
            "same-origin",
        ))
        .layer(set(
            HeaderName::from_static("cross-origin-resource-policy"),
            "same-origin",
        ))
        .layer(set(
            HeaderName::from_static("x-permitted-cross-domain-policies"),
            "none",
        ))
        .layer(set(HeaderName::from_static("origin-agent-cluster"), "?1"))
}

/// The built page. Hashed assets are immutable; everything else (the shell,
/// and any unknown path, which falls back to it) is never cached, so a
/// deploy is picked up on the next load.
fn static_site(dir: &std::path::Path) -> Router {
    let index = dir.join("index.html");
    let assets = Router::new()
        .fallback_service(ServeDir::new(dir.join("assets")))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        ));
    let shell = ServeDir::new(dir).fallback(ServeFile::new(index));
    Router::new().nest("/assets", assets).fallback_service(
        tower::ServiceBuilder::new()
            .layer(SetResponseHeaderLayer::overriding(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-store"),
            ))
            .service(shell),
    )
}

pub fn app(state: AppState) -> Router {
    let bff = Router::new()
        .route("/bff/v1/{*rest}", any(bff::proxy))
        .route("/web/me", get(auth::me))
        .route("/web/mic", post(mic::mic))
        .route("/web/credits", get(credits::get).post(credits::update))
        .route(
            "/web/reminders",
            get(reminders::list).post(reminders::create),
        )
        .route("/web/reminders/{id}/cancel", post(reminders::cancel))
        .route("/web/reminders/{id}/delivered", post(reminders::delivered))
        .route("/web/reminders/snooze", post(reminders::snooze))
        .route(
            "/web/notes",
            get(reminders::notes).post(reminders::add_note),
        )
        .route("/web/notes/{id}/close", post(reminders::close_note))
        .route("/web/visit", post(reminders::visit))
        .route("/web/sessions/revoke-all", post(auth::revoke_all))
        .route(
            "/web/passkeys",
            get(passkey::list).post(passkey::finish_register),
        )
        .route("/web/passkeys/begin", post(passkey::begin_register))
        .route("/web/passkeys/{id}/remove", post(passkey::remove))
        .route("/web/security", get(honey::get))
        .route("/web/security/unban", post(honey::unban))
        .route("/web/intel/feed", get(intel::feed))
        .route("/web/intel/search", get(intel::search))
        .route(
            "/web/intel/layer/{name}",
            // The flight layer is ~1 MB of JSON and Caddy doesn't compress.
            get(layers::layer).layer(tower_http::compression::CompressionLayer::new()),
        )
        .route("/web/intel/cam/{id}/still", get(cams::still))
        .route("/web/intel/cam/{id}/hls/{file}", get(cams::hls))
        .route("/web/watches", get(watches::list).post(watches::create))
        .route("/web/watches/{id}/remove", post(watches::remove))
        .route("/web/watches/seen", post(watches::seen))
        .route("/web/local", get(local::get))
        .route("/web/route", get(route::get))
        .route("/web/projects", get(projects::list))
        .route("/web/projects/github", post(projects::create_repo))
        .route(
            "/web/projects/github/{owner}/{repo}/models",
            get(projects::models),
        )
        .route(
            "/web/projects/github/{owner}/{repo}/file",
            get(projects::file),
        )
        .route("/web/projects/local", post(projects::create_local))
        .route(
            "/web/projects/local/{id}/remove",
            post(projects::remove_local),
        )
        .route(
            "/web/projects/local/{id}/session",
            post(projects::set_session),
        )
        .route(
            "/web/projects/github/{owner}/{repo}/tree",
            get(projects::tree),
        )
        .route(
            "/web/projects/github/{owner}/{repo}/write",
            post(projects::write_file),
        )
        .route(
            "/web/projects/github/{owner}/{repo}/move",
            post(projects::move_file),
        )
        .route_layer(from_fn_with_state(state.clone(), auth::require_session));

    let api = Router::new()
        .route("/auth/login", post(auth::login))
        .route("/auth/passkey", post(passkey::login))
        .route("/auth/profiles", get(auth::profiles))
        // No session needed: a browser whose session already lapsed still
        // gets its cookie cleared.
        .route("/auth/logout", post(auth::logout))
        .route("/healthz", get(|| async { "ok" }))
        .merge(bff)
        .layer(from_fn(auth::require_csrf_header))
        .layer(from_fn(auth::require_same_site))
        // Times the wait for response headers only, so the SSE feed and file
        // downloads still stream for as long as they run.
        .layer(TimeoutLayer::with_status_code(
            StatusCode::GATEWAY_TIMEOUT,
            Duration::from_secs(60),
        ))
        .layer(ConcurrencyLimitLayer::new(64))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .with_state(state.clone());

    let router = match &state.config.static_dir {
        Some(dir) => api.merge(static_site(dir)),
        None => api,
    };
    security_headers(
        router
            .layer(from_fn_with_state(state.clone(), honey::guard))
            .layer(from_fn(request_id::layer))
            .layer(TraceLayer::new_for_http()),
    )
}

/// Where an outbound fetch may be redirected: an https site named by a
/// public domain, never an IP literal or a bare name like `api` — so no
/// redirect can point this server at its own network or the metadata
/// address. Nothing this server talks to redirects anywhere else.
fn redirect_ok(url: &reqwest::Url) -> bool {
    let host = url.host_str().unwrap_or_default();
    url.scheme() == "https"
        && host.contains('.')
        && host.parse::<std::net::Ipv4Addr>().is_err()
        && !host.starts_with('[')
        && ![".internal", ".local", ".localhost"]
            .iter()
            .any(|t| host.ends_with(t))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("os randomness");
    b
}

#[cfg(test)]
mod tests {
    #[test]
    fn redirects_only_reach_public_https_sites() {
        for (u, ok) in [
            ("https://wzmedia.dot.ca.gov/x.jpg", true),
            ("http://wzmedia.dot.ca.gov/x.jpg", false),
            ("http://api:8100/v1/keys", false),
            ("https://api/v1/keys", false),
            ("http://169.254.169.254/latest/meta-data", false),
            ("https://127.0.0.1/", false),
            ("https://[::1]/", false),
            ("https://metadata.google.internal/", false),
        ] {
            assert_eq!(super::redirect_ok(&u.parse().unwrap()), ok, "{u}");
        }
    }
}
