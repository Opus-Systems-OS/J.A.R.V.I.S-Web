//! The honeypot. Nothing on this site lives at `/.env`, `/wp-login.php`,
//! `/admin` or `/bff/v1/keys`, so anything that asks is scanning. It gets
//! bait, and its address is banned until someone lifts the ban — from the
//! Systems tab or with `jarvis-web unban <ip>` on the droplet.
//!
//! Three tripwires, all ending in the same ban:
//! - **trap paths** (`is_trap`): `/.env` answers with a believable env file
//!   whose only credential is the canary passphrase; the rest 404;
//! - **the canary**: that passphrase, tried at the lock, only comes from
//!   someone who read the bait;
//! - **the honey field**: an off-screen input on the lock form that people
//!   never see and form-filling bots fill.
//!
//! Safety rails: a request carrying a valid unlock cookie is never banned
//! (its trap hits are only logged), and neither is any address that isn't a
//! single public client — `unknown`, private, loopback, link-local or CGNAT.
//! On the droplet every IPv6 visitor reaches Caddy through Docker's userland
//! proxy as the bridge gateway (`172.18.0.1`), so banning that one would
//! ban them all. Banned addresses get a 403 on every route, unless they hold
//! a valid cookie.

use crate::auth::{self, client_ip};
use crate::config::Profile;
use crate::db::{Ban, TrapHit};
use crate::error::{Error, Result};
use crate::AppState;
use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};

/// Paths no part of this site uses, matched case-insensitively from the
/// start of the path.
const TRAP_PREFIXES: &[&str] = &[
    "/.env",
    "/.git",
    "/.aws",
    "/.ssh",
    "/.svn",
    "/.ds_store",
    "/wp-",
    "/wordpress",
    "/xmlrpc",
    "/phpmyadmin",
    "/pma",
    "/admin",
    "/server-status",
    "/actuator",
    "/config.json",
    "/backup",
    "/cgi-bin",
    "/vendor/",
];
/// The API's key and pairing areas, which the page never calls: matched as
/// whole segments.
const TRAP_SEGMENTS: &[&str] = &["/bff/v1/keys", "/bff/v1/pair"];

const MAX_LOGGED: usize = 200;

/// A ban's reason.
pub const TRAP: &str = "trap";
pub const CANARY: &str = "canary";
pub const HONEYFIELD: &str = "honeyfield";

pub fn is_trap(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    TRAP_PREFIXES.iter().any(|t| p.starts_with(t))
        || p.ends_with(".php")
        || TRAP_SEGMENTS
            .iter()
            .any(|t| p == *t || p.strip_prefix(t).is_some_and(|r| r.starts_with('/')))
}

/// A bait passphrase: 24 lowercase letters and digits.
pub fn new_canary() -> String {
    const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
    crate::random_bytes::<24>()
        .iter()
        .map(|b| ALPHABET[usize::from(*b) % ALPHABET.len()] as char)
        .collect()
}

fn clip(s: &str) -> String {
    s.chars().take(MAX_LOGGED).collect()
}

/// Whether `ip` can be banned at all: only a public address names one
/// client. Anything else may stand for many (see the module docs).
fn bannable(ip: &str) -> bool {
    use std::net::IpAddr;
    match ip.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || (a == 100 && (64..128).contains(&b))) // CGNAT 100.64/10
        }
        Ok(IpAddr::V6(v6)) => {
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || (first & 0xfe00) == 0xfc00 // unique local fc00::/7
                || (first & 0xffc0) == 0xfe80) // link-local fe80::/10
        }
        Err(_) => false,
    }
}

/// Ban `ip` for `reason`. Returns whether it was banned (an unreadable
/// address is not).
pub fn ban(state: &AppState, ip: &str, reason: &str, path: &str) -> Result<bool> {
    if !bannable(ip) {
        tracing::warn!(honeypot = true, %ip, reason, path, "honeypot tripped; address unknown, not banned");
        return Ok(false);
    }
    state.db.ban(ip, reason, &clip(path))?;
    tracing::warn!(honeypot = true, %ip, reason, path, "honeypot tripped; banned");
    Ok(true)
}

fn bait(canary: &str) -> String {
    format!(
        "# jarvis-web production\n\
         NODE_ENV=production\n\
         PORT=8200\n\
         DATABASE_URL=sqlite:///data/jarvis.db\n\
         SESSION_HOURS=12\n\
         JARVIS_WEB_PASSWORD={canary}\n"
    )
}

/// Middleware, outermost after the request id: traps first, then the ban.
pub async fn guard(State(state): State<AppState>, req: Request, next: Next) -> Result<Response> {
    let path = req.uri().path().to_owned();
    let trap = is_trap(&path);
    let ip = client_ip(req.headers());
    // A cookie lookup only when it could matter.
    let banned = !trap && bannable(&ip) && state.db.is_banned(&ip)?;
    if !trap && !banned {
        return Ok(next.run(req).await);
    }
    let unlocked = auth::unlocked_profile(&state, req.headers())?.is_some();
    if !trap {
        return if unlocked {
            Ok(next.run(req).await)
        } else {
            Err(Error::Forbidden("blocked"))
        };
    }

    let ua = req
        .headers()
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let banned = !unlocked && ban(&state, &ip, TRAP, &path)?;
    state.db.record_trap(&ip, &clip(&path), &clip(ua), banned)?;
    if unlocked {
        tracing::warn!(honeypot = true, %ip, %path, "trap hit from an unlocked browser; not banned");
        return Err(Error::NotFound);
    }
    if path.to_ascii_lowercase().starts_with("/.env") {
        return Ok((
            StatusCode::OK,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            bait(&state.db.canary()?),
        )
            .into_response());
    }
    Err(Error::NotFound)
}

#[derive(Debug, Serialize)]
pub struct Security {
    pub bans: Vec<Ban>,
    pub hits: Vec<TrapHit>,
}

/// `GET /web/security` (the owner's profile): bans, and the latest hits.
pub async fn get(
    State(state): State<AppState>,
    Extension(p): Extension<Profile>,
) -> Result<Json<Security>> {
    auth::require_full(&p)?;
    Ok(Json(Security {
        bans: state.db.bans()?,
        hits: state.db.trap_hits(50)?,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UnbanBody {
    pub ip: String,
}

/// `POST /web/security/unban` (the owner's profile).
pub async fn unban(
    State(state): State<AppState>,
    Extension(p): Extension<Profile>,
    Json(body): Json<UnbanBody>,
) -> Result<StatusCode> {
    auth::require_full(&p)?;
    if !state.db.unban(body.ip.trim())? {
        return Err(Error::NotFound);
    }
    tracing::info!(honeypot = true, ip = %body.ip.trim(), "unbanned from the HUD");
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traps_catch_scanners_and_nothing_the_site_uses() {
        for p in [
            "/.env",
            "/.env.production",
            "/.git/config",
            "/.AWS/credentials",
            "/wp-login.php",
            "/wp-admin/",
            "/xmlrpc.php",
            "/index.php",
            "/phpMyAdmin/",
            "/admin",
            "/administrator/index",
            "/actuator/health",
            "/server-status",
            "/backup.zip",
            "/bff/v1/keys",
            "/bff/v1/keys/abc",
            "/bff/v1/pair/123/approve",
        ] {
            assert!(is_trap(p), "{p}");
        }
        for p in [
            "/",
            "/index.html",
            "/privacy.html",
            "/privacy.css",
            "/favicon.svg",
            "/capture-worklet.js",
            "/assets/index-abc.js",
            "/auth/login",
            "/auth/profiles",
            "/healthz",
            "/web/me",
            "/web/security",
            "/bff/v1/me",
            "/bff/v1/sessions/sesn_1/stream",
            "/bff/v1/keysmith",
            "/.well-known/security.txt",
        ] {
            assert!(!is_trap(p), "{p}");
        }
    }

    #[test]
    fn only_a_public_address_can_be_banned() {
        for ip in ["198.51.100.7", "67.127.41.1", "2604:a880:400:d1::1"] {
            assert!(bannable(ip), "{ip}");
        }
        for ip in [
            "unknown",
            "",
            "172.18.0.1", // the Docker bridge gateway: every IPv6 visitor
            "10.0.0.5",
            "192.168.1.2",
            "127.0.0.1",
            "169.254.1.1",
            "100.79.233.8", // tailnet (CGNAT)
            "0.0.0.0",
            "::1",
            "fd7a:115c:a1e0::1",
            "fe80::1",
        ] {
            assert!(!bannable(ip), "{ip}");
        }
    }

    #[test]
    fn the_canary_looks_like_a_passphrase() {
        let c = new_canary();
        assert_eq!(c.len(), 24);
        assert!(c
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()));
        assert_ne!(c, new_canary());
        assert!(bait(&c).contains(&c));
    }
}
