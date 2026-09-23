//! The password gate. One password (Argon2id hash in the droplet `.env`),
//! one kind of session: a 256-bit random token in a `__Host-` cookie
//! (HttpOnly, Secure, SameSite=Strict), stored here only as its SHA-256.
//!
//! Brute force is bounded before any hashing happens: 5 failures per IP per
//! 15 minutes and 30 per hour from everyone. Mutating requests must carry
//! `x-jarvis: 1`, which a cross-site form cannot send and a cross-site
//! `fetch` cannot send without a CORS preflight this server never answers.

use crate::error::{Error, Result};
use crate::AppState;
use argon2::password_hash::{PasswordHash, PasswordVerifier};
use argon2::Argon2;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use sha2::{Digest, Sha256};

pub const COOKIE: &str = "__Host-jw";
pub const CSRF_HEADER: &str = "x-jarvis";

const IP_WINDOW_SECS: i64 = 15 * 60;
const IP_MAX_FAILURES: u32 = 5;
const GLOBAL_WINDOW_SECS: i64 = 3600;
const GLOBAL_MAX_FAILURES: u32 = 30;
const MAX_PASSWORD_BYTES: usize = 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoginBody {
    pub password: String,
}

fn sha256_hex(s: &str) -> String {
    crate::hex(&Sha256::digest(s.as_bytes()))
}

/// The browser's address as Caddy saw it. Caddy is the only way in (the
/// container publishes no port) and, with no `trusted_proxies`, replaces any
/// client-sent `X-Forwarded-For` with the real peer — so the last entry is
/// the client.
pub fn client_ip(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit(',').next())
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty() && v.len() <= 64)
        .unwrap_or_else(|| "unknown".to_owned())
}

fn cookie_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == COOKIE)
        .map(|(_, value)| value.to_owned())
        .filter(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn check_limits(state: &AppState, ip: &str) -> Result<()> {
    let now = crate::db::now();
    let (n, oldest) = state.db.failures_since(Some(ip), now - IP_WINDOW_SECS)?;
    if n >= IP_MAX_FAILURES {
        let retry = oldest.map_or(IP_WINDOW_SECS, |t| t + IP_WINDOW_SECS - now);
        return Err(Error::RateLimited {
            retry_after_secs: retry.max(1) as u32,
        });
    }
    let (n, oldest) = state.db.failures_since(None, now - GLOBAL_WINDOW_SECS)?;
    if n >= GLOBAL_MAX_FAILURES {
        tracing::warn!(failures = n, "unlock locked globally");
        let retry = oldest.map_or(GLOBAL_WINDOW_SECS, |t| t + GLOBAL_WINDOW_SECS - now);
        return Err(Error::RateLimited {
            retry_after_secs: retry.max(1) as u32,
        });
    }
    Ok(())
}

async fn verify(hash: String, password: String) -> Result<bool> {
    tokio::task::spawn_blocking(move || {
        let parsed =
            PasswordHash::new(&hash).map_err(|e| Error::Internal(format!("password hash: {e}")))?;
        Ok(Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok())
    })
    .await
    .map_err(|e| Error::Internal(format!("verify task: {e}")))?
}

pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> Result<Response> {
    let ip = client_ip(&headers);
    check_limits(&state, &ip)?;
    if body.password.is_empty() || body.password.len() > MAX_PASSWORD_BYTES {
        state.db.record_failure(&ip)?;
        return Err(Error::Unauthorized);
    }
    if !verify(state.config.password_hash.clone(), body.password).await? {
        state.db.record_failure(&ip)?;
        tracing::warn!(%ip, "unlock failed");
        return Err(Error::Unauthorized);
    }
    state.db.clear_failures(&ip)?;

    let token = crate::hex(&crate::random_bytes::<32>());
    let ttl = i64::from(state.config.session_hours) * 3600;
    state.db.insert_session(&sha256_hex(&token), ttl, &ip)?;
    tracing::info!(%ip, "unlocked");

    let cookie =
        format!("{COOKIE}={token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age={ttl}");
    let mut res = StatusCode::NO_CONTENT.into_response();
    res.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).map_err(|e| Error::Internal(e.to_string()))?,
    );
    Ok(res)
}

pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response> {
    if let Some(token) = cookie_token(&headers) {
        state.db.delete_session(&sha256_hex(&token))?;
    }
    let mut res = StatusCode::NO_CONTENT.into_response();
    res.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static(
            "__Host-jw=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
        ),
    );
    Ok(res)
}

/// Middleware: an unlocked session is required.
pub async fn require_session(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response> {
    let token = cookie_token(req.headers()).ok_or(Error::Unauthorized)?;
    if !state.db.session_valid(&sha256_hex(&token))? {
        return Err(Error::Unauthorized);
    }
    Ok(next.run(req).await)
}

/// Middleware: anything that changes state must say `x-jarvis: 1`.
pub async fn require_csrf_header(req: Request, next: Next) -> Result<Response> {
    let safe = matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    let marked = req
        .headers()
        .get(CSRF_HEADER)
        .is_some_and(|v| v.as_bytes() == b"1");
    if !safe && !marked {
        return Err(Error::Forbidden("missing x-jarvis header"));
    }
    Ok(next.run(req).await)
}

/// `jarvis-web hash-password`: read a password from the terminal twice (or,
/// when stdin is not a terminal, one line from stdin) and print its Argon2id
/// PHC string for `JARVIS_WEB_PASSWORD_HASH`.
pub fn hash_password_interactive() -> Result<String> {
    use std::io::{BufRead, IsTerminal};
    let read_err = |e: std::io::Error| Error::Internal(format!("read password: {e}"));
    let first = if std::io::stdin().is_terminal() {
        let first = rpassword::prompt_password("Password: ").map_err(read_err)?;
        let second = rpassword::prompt_password("Again: ").map_err(read_err)?;
        if first != second {
            return Err(Error::InvalidRequest("passwords differ".to_owned()));
        }
        first
    } else {
        let mut line = String::new();
        std::io::stdin()
            .lock()
            .read_line(&mut line)
            .map_err(read_err)?;
        line.trim_end_matches(['\r', '\n']).to_owned()
    };
    if first.len() < 12 || first.len() > MAX_PASSWORD_BYTES {
        return Err(Error::InvalidRequest(
            "password must be 12 to 1024 bytes".to_owned(),
        ));
    }
    hash_password(&first)
}

pub fn hash_password(password: &str) -> Result<String> {
    use argon2::password_hash::{PasswordHasher, SaltString};
    let salt = SaltString::encode_b64(&crate::random_bytes::<16>())
        .map_err(|e| Error::Internal(format!("salt: {e}")))?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| Error::Internal(format!("hash: {e}")))
}
