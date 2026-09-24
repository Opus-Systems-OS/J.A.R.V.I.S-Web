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
pub mod config;
pub mod db;
pub mod error;
pub mod mic;
pub mod request_id;

use axum::http::{header, HeaderName, HeaderValue};
use axum::middleware::{from_fn, from_fn_with_state};
use axum::routing::{any, get, post};
use axum::Router;
use config::Config;
use std::time::Duration;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub db: db::Db,
    pub http: reqwest::Client,
    pub mic: std::sync::Arc<mic::Lease>,
}

impl AppState {
    pub fn new(config: Config, db: db::Db) -> error::Result<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .build()?;
        Ok(AppState {
            config,
            db,
            http,
            mic: std::sync::Arc::default(),
        })
    }
}

/// Content-Security-Policy for everything served: the page loads nothing
/// from anywhere but this origin, and talks to nothing but this origin.
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; \
img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; \
worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

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
            "microphone=(self), camera=(), geolocation=(), payment=(), usb=()",
        ))
        .layer(set(
            header::STRICT_TRANSPORT_SECURITY,
            "max-age=31536000; includeSubDomains",
        ))
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
        .route("/auth/logout", post(auth::logout))
        .route("/web/mic", post(mic::mic))
        .route_layer(from_fn_with_state(state.clone(), auth::require_session));

    let api = Router::new()
        .route("/auth/login", post(auth::login))
        .route("/healthz", get(|| async { "ok" }))
        .merge(bff)
        .layer(from_fn(auth::require_csrf_header))
        .with_state(state.clone());

    let router = match &state.config.static_dir {
        Some(dir) => api.merge(static_site(dir)),
        None => api,
    };
    security_headers(
        router
            .layer(from_fn(request_id::layer))
            .layer(TraceLayer::new_for_http()),
    )
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("os randomness");
    b
}
