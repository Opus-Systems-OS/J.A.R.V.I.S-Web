//! One microphone for all open HUDs. Every tab or browser with the HUD open
//! would otherwise hear "Jarvis, …" and answer it — twice the cost, two
//! voices. The page holds a short lease here: it renews every few seconds,
//! a lease not renewed for `TTL` lapses, and a tab can deliberately take it
//! over (clicking the orb). Memory only: a restart just means the next
//! renewal wins. One lease per profile: Mr. Walker's HUD and Mr. Powers's
//! never take each other's microphone.

use crate::config::Profile;
use crate::error::{Error, Result};
use crate::AppState;
use axum::extract::State;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const TTL: Duration = Duration::from_secs(20);

/// Profile id → (holding client, last renewal).
#[derive(Default)]
pub struct Lease {
    holders: Mutex<HashMap<String, (String, Instant)>>,
}

impl Lease {
    /// Grant (or renew) `profile`'s lease to `client` if it is free, lapsed,
    /// already theirs, or `take` is set. Returns whether `client` holds it now.
    pub fn claim(&self, profile: &str, client: &str, take: bool, now: Instant) -> bool {
        let mut h = self.holders.lock().unwrap_or_else(|p| p.into_inner());
        let free = match h.get(profile) {
            None => true,
            Some((who, at)) => who == client || now.duration_since(*at) > TTL,
        };
        if free || take {
            h.insert(profile.to_owned(), (client.to_owned(), now));
            true
        } else {
            false
        }
    }

    pub fn release(&self, profile: &str, client: &str) {
        let mut h = self.holders.lock().unwrap_or_else(|p| p.into_inner());
        if h.get(profile).is_some_and(|(who, _)| who == client) {
            h.remove(profile);
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MicRequest {
    /// A random id per open HUD (per tab).
    pub client: String,
    /// Take the mic even if another HUD holds it.
    #[serde(default)]
    pub take: bool,
    /// Give it up (the HUD is closing or locking).
    #[serde(default)]
    pub release: bool,
}

#[derive(Debug, Serialize)]
pub struct MicState {
    pub held: bool,
    pub ttl_secs: u64,
}

pub async fn mic(
    State(state): State<AppState>,
    Extension(profile): Extension<Profile>,
    Json(req): Json<MicRequest>,
) -> Result<Json<MicState>> {
    let ok = (8..=64).contains(&req.client.len())
        && req
            .client
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if !ok {
        return Err(Error::InvalidRequest(
            "client must be 8-64 chars of [A-Za-z0-9-]".into(),
        ));
    }
    if req.release {
        state.mic.release(&profile.id, &req.client);
        return Ok(Json(MicState {
            held: false,
            ttl_secs: TTL.as_secs(),
        }));
    }
    let held = state
        .mic
        .claim(&profile.id, &req.client, req.take, Instant::now());
    Ok(Json(MicState {
        held,
        ttl_secs: TTL.as_secs(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_holder_renewals_lapse_and_takeover() {
        let l = Lease::default();
        let t0 = Instant::now();
        assert!(l.claim("walker", "tab-aaaa", false, t0));
        assert!(
            !l.claim("walker", "tab-bbbb", false, t0 + Duration::from_secs(5)),
            "held elsewhere"
        );
        assert!(
            l.claim("walker", "tab-aaaa", false, t0 + Duration::from_secs(10)),
            "renewal"
        );
        assert!(
            !l.claim("walker", "tab-bbbb", false, t0 + Duration::from_secs(25)),
            "renewed at 10 s, so still held at 25 s"
        );
        assert!(
            l.claim("walker", "tab-bbbb", false, t0 + Duration::from_secs(31)),
            "lapsed"
        );
        assert!(!l.claim("walker", "tab-aaaa", false, t0 + Duration::from_secs(32)));
        assert!(
            l.claim("walker", "tab-aaaa", true, t0 + Duration::from_secs(33)),
            "deliberate takeover"
        );
        l.release("walker", "tab-bbbb");
        assert!(
            !l.claim("walker", "tab-bbbb", false, t0 + Duration::from_secs(34)),
            "only the holder can release"
        );
        l.release("walker", "tab-aaaa");
        assert!(l.claim("walker", "tab-bbbb", false, t0 + Duration::from_secs(35)));
    }

    #[test]
    fn each_profile_has_its_own_microphone() {
        let l = Lease::default();
        let t0 = Instant::now();
        assert!(l.claim("walker", "tab-aaaa", false, t0));
        assert!(l.claim("powers", "tab-bbbb", false, t0), "his own lease");
        assert!(l.claim("walker", "tab-aaaa", false, t0 + Duration::from_secs(1)));
        l.release("powers", "tab-aaaa");
        assert!(!l.claim("powers", "tab-cccc", false, t0 + Duration::from_secs(2)));
    }
}
