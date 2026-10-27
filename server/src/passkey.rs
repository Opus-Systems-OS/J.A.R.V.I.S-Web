//! Passkeys: the second step of an unlock. A profile with none unlocks with
//! its password alone; once it has one, the password only earns a challenge
//! and the session starts when a passkey signs it (Face ID or Touch ID, via
//! iCloud Keychain, or a security key). The authenticator must verify the
//! person (`UV`), so a stolen password and an unlocked phone are two things
//! to have, not one.
//!
//! The browser's `getPublicKey()` hands over the key at enrolment, so no
//! attestation is parsed; only P-256 (ES256, what Apple, Google and security
//! keys all offer) is accepted, and signatures are checked with `p256`.
//! shortcut: the signature counter is not tracked (synced passkeys report 0),
//! so a cloned authenticator is not detected; add it if hardware keys only.

use crate::auth::{check_limits, client_ip, start_session};
use crate::config::Profile;
use crate::error::{Error, Result};
use crate::AppState;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine as _;
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use p256::pkcs8::DecodePublicKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;

const CHALLENGE_SECS: i64 = 120;
const MAX_CHALLENGES: usize = 256;
const MAX_FIELD: usize = 8192;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Register,
    Login,
}

pub struct Pending {
    kind: Kind,
    profile: String,
    expires: i64,
}

/// Challenges issued and not yet answered, by value. In memory on purpose: a
/// restart only costs whoever was mid-prompt a retry.
pub type Challenges = Mutex<HashMap<String, Pending>>;

fn issue(state: &AppState, kind: Kind, profile: &str) -> Result<String> {
    let now = crate::db::now();
    let mut map = state.challenges.lock().unwrap_or_else(|p| p.into_inner());
    map.retain(|_, p| p.expires > now);
    if map.len() >= MAX_CHALLENGES {
        return Err(Error::RateLimited {
            retry_after_secs: CHALLENGE_SECS as u32,
        });
    }
    let challenge = B64.encode(crate::random_bytes::<32>());
    map.insert(
        challenge.clone(),
        Pending {
            kind,
            profile: profile.to_owned(),
            expires: now + CHALLENGE_SECS,
        },
    );
    Ok(challenge)
}

/// One use only, whatever the outcome.
fn take(state: &AppState, challenge: &str, kind: Kind) -> Option<Pending> {
    let mut map = state.challenges.lock().unwrap_or_else(|p| p.into_inner());
    map.remove(challenge)
        .filter(|p| p.kind == kind && p.expires > crate::db::now())
}

/// `https://jarvis.opustower.dev` -> `jarvis.opustower.dev`.
fn rp_id(origin: &str) -> &str {
    let host = origin.split_once("://").map_or(origin, |(_, h)| h);
    host.split(['/', ':']).next().unwrap_or(host)
}

fn decode(field: &str) -> Result<Vec<u8>> {
    if field.len() > MAX_FIELD {
        return Err(Error::InvalidRequest("field too long".to_owned()));
    }
    B64.decode(field)
        .map_err(|_| Error::InvalidRequest("not base64url".to_owned()))
}

#[derive(Deserialize)]
struct ClientData {
    #[serde(rename = "type")]
    kind: String,
    challenge: String,
    origin: String,
    #[serde(default, rename = "crossOrigin")]
    cross_origin: bool,
}

fn client_data_ok(raw: &[u8], kind: &str, challenge: &str, origin: &str) -> bool {
    serde_json::from_slice::<ClientData>(raw).is_ok_and(|c| {
        c.kind == kind && c.challenge == challenge && c.origin == origin && !c.cross_origin
    })
}

/// A signed login: this origin, this challenge, this site's rp id, the user
/// present and verified, and the stored key's signature over it all.
fn assertion_ok(
    origin: &str,
    challenge: &str,
    key_der: &[u8],
    client_data: &[u8],
    auth_data: &[u8],
    signature: &[u8],
) -> bool {
    const UP_AND_UV: u8 = 0x01 | 0x04;
    if !client_data_ok(client_data, "webauthn.get", challenge, origin)
        || auth_data.len() < 37
        || auth_data[..32] != Sha256::digest(rp_id(origin).as_bytes())[..]
        || auth_data[32] & UP_AND_UV != UP_AND_UV
    {
        return false;
    }
    let (Ok(key), Ok(sig)) = (
        VerifyingKey::from_public_key_der(key_der),
        Signature::from_der(signature),
    ) else {
        return false;
    };
    let sig = sig.normalize_s();
    let mut signed = auth_data.to_vec();
    signed.extend_from_slice(&Sha256::digest(client_data));
    key.verify(&signed, &sig).is_ok()
}

// ---- login ------------------------------------------------------------------

/// What the lock screen gets after a right password, instead of a cookie.
#[derive(Serialize)]
struct LoginChallenge {
    second_factor: &'static str,
    challenge: String,
    rp_id: String,
    credentials: Vec<String>,
}

pub fn challenge_login(state: &AppState, profile: &str) -> Result<Response> {
    let challenge = issue(state, Kind::Login, profile)?;
    Ok(Json(LoginChallenge {
        second_factor: "passkey",
        challenge,
        rp_id: rp_id(&state.config.public_origin).to_owned(),
        credentials: state
            .db
            .passkeys(profile)?
            .into_iter()
            .map(|(id, ..)| id)
            .collect(),
    })
    .into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoginBody {
    challenge: String,
    id: String,
    client_data_json: String,
    authenticator_data: String,
    signature: String,
}

/// `POST /auth/passkey` (no session): the passkey's answer to the challenge
/// `/auth/login` returned. Failures count against the address like a wrong
/// password does.
pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> Result<Response> {
    let ip = client_ip(&headers);
    check_limits(&state, &ip)?;
    let verified = (|| {
        let pending = take(&state, &body.challenge, Kind::Login)?;
        let key = state.db.passkey_key(&pending.profile, &body.id).ok()??;
        assertion_ok(
            &state.config.public_origin,
            &body.challenge,
            &key,
            &decode(&body.client_data_json).ok()?,
            &decode(&body.authenticator_data).ok()?,
            &decode(&body.signature).ok()?,
        )
        .then_some(pending.profile)
    })();
    let Some(profile) = verified.filter(|p| state.config.profile(p).is_some()) else {
        state.db.record_failure(&ip)?;
        tracing::warn!(%ip, "passkey failed");
        return Err(Error::Unauthorized);
    };
    state.db.clear_failures(&ip)?;
    start_session(&state, &ip, &profile)
}

// ---- enrolment (an unlocked session) -------------------------------------------

#[derive(Serialize)]
pub struct RegisterChallenge {
    challenge: String,
    rp_id: String,
    rp_name: &'static str,
    user_id: String,
    user_name: String,
    exclude: Vec<String>,
}

/// `POST /web/passkeys/begin`: the challenge to make a new passkey against.
pub async fn begin_register(
    State(state): State<AppState>,
    Extension(p): Extension<Profile>,
) -> Result<Json<RegisterChallenge>> {
    Ok(Json(RegisterChallenge {
        challenge: issue(&state, Kind::Register, &p.id)?,
        rp_id: rp_id(&state.config.public_origin).to_owned(),
        rp_name: "J.A.R.V.I.S.",
        user_id: B64.encode(p.id.as_bytes()),
        user_name: p.name,
        exclude: state
            .db
            .passkeys(&p.id)?
            .into_iter()
            .map(|(id, ..)| id)
            .collect(),
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterBody {
    challenge: String,
    id: String,
    client_data_json: String,
    /// SPKI DER from `AuthenticatorAttestationResponse.getPublicKey()`.
    public_key: String,
    #[serde(default)]
    label: String,
}

/// `POST /web/passkeys`: store the passkey the browser just made.
pub async fn finish_register(
    State(state): State<AppState>,
    Extension(p): Extension<Profile>,
    Json(body): Json<RegisterBody>,
) -> Result<StatusCode> {
    let bad = |m: &str| Error::InvalidRequest(m.to_owned());
    let pending = take(&state, &body.challenge, Kind::Register)
        .filter(|c| c.profile == p.id)
        .ok_or_else(|| bad("the challenge expired; try again"))?;
    debug_assert_eq!(pending.profile, p.id);
    let client_data = decode(&body.client_data_json)?;
    if !client_data_ok(
        &client_data,
        "webauthn.create",
        &body.challenge,
        &state.config.public_origin,
    ) {
        return Err(bad("passkey was made for another site"));
    }
    let key = decode(&body.public_key)?;
    if VerifyingKey::from_public_key_der(&key).is_err() {
        return Err(bad("only P-256 passkeys are supported"));
    }
    if !(16..=1024).contains(&decode(&body.id)?.len()) {
        return Err(bad("bad credential id"));
    }
    let label: String = body.label.trim().chars().take(40).collect();
    let label = if label.is_empty() {
        "Passkey".to_owned()
    } else {
        label
    };
    state.db.add_passkey(&p.id, &body.id, &key, &label)?;
    tracing::info!(profile = %p.id, "passkey added");
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
pub struct PasskeyOut {
    id: String,
    label: String,
    created_at: i64,
}

/// `GET /web/passkeys`: this profile's passkeys.
pub async fn list(
    State(state): State<AppState>,
    Extension(p): Extension<Profile>,
) -> Result<Json<Vec<PasskeyOut>>> {
    Ok(Json(
        state
            .db
            .passkeys(&p.id)?
            .into_iter()
            .map(|(id, label, created_at)| PasskeyOut {
                id,
                label,
                created_at,
            })
            .collect(),
    ))
}

/// `POST /web/passkeys/{id}/remove`.
pub async fn remove(
    State(state): State<AppState>,
    Extension(p): Extension<Profile>,
    Path(id): Path<String>,
) -> Result<StatusCode> {
    if state.db.remove_passkey(&p.id, &id)? {
        tracing::info!(profile = %p.id, "passkey removed");
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(Error::NotFound)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::SigningKey;
    use p256::pkcs8::EncodePublicKey;

    const ORIGIN: &str = "https://jarvis.example";

    fn key() -> (SigningKey, Vec<u8>) {
        let sk = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let der = sk.verifying_key().to_public_key_der().unwrap();
        (sk, der.as_bytes().to_vec())
    }

    fn client_data(kind: &str, challenge: &str, origin: &str) -> Vec<u8> {
        format!(r#"{{"type":"{kind}","challenge":"{challenge}","origin":"{origin}"}}"#).into_bytes()
    }

    fn auth_data(flags: u8) -> Vec<u8> {
        let mut d = Sha256::digest(rp_id(ORIGIN).as_bytes()).to_vec();
        d.push(flags);
        d.extend_from_slice(&[0, 0, 0, 0]);
        d
    }

    fn sign(sk: &SigningKey, cd: &[u8], ad: &[u8]) -> Vec<u8> {
        let mut m = ad.to_vec();
        m.extend_from_slice(&Sha256::digest(cd));
        let s: Signature = sk.sign(&m);
        s.to_der().as_bytes().to_vec()
    }

    #[test]
    fn rp_id_is_the_host() {
        assert_eq!(
            rp_id("https://jarvis.opustower.dev"),
            "jarvis.opustower.dev"
        );
        assert_eq!(rp_id("http://localhost:8200"), "localhost");
    }

    #[test]
    fn a_verified_signature_over_this_challenge_passes_and_nothing_else_does() {
        let (sk, der) = key();
        let cd = client_data("webauthn.get", "abc", ORIGIN);
        let ad = auth_data(0x05);
        let sig = sign(&sk, &cd, &ad);
        assert!(assertion_ok(ORIGIN, "abc", &der, &cd, &ad, &sig));

        // Another challenge, origin or type.
        assert!(!assertion_ok(ORIGIN, "xyz", &der, &cd, &ad, &sig));
        assert!(!assertion_ok(
            "https://evil.example",
            "abc",
            &der,
            &cd,
            &ad,
            &sig
        ));
        let create = client_data("webauthn.create", "abc", ORIGIN);
        assert!(!assertion_ok(
            ORIGIN,
            "abc",
            &der,
            &create,
            &ad,
            &sign(&sk, &create, &ad)
        ));
        // Present but not verified (a bare touch), or not present at all.
        for flags in [0x01, 0x04, 0x00] {
            let ad = auth_data(flags);
            assert!(!assertion_ok(
                ORIGIN,
                "abc",
                &der,
                &cd,
                &ad,
                &sign(&sk, &cd, &ad)
            ));
        }
        // Another key, or a tampered signature.
        let other = SigningKey::from_slice(&[9u8; 32]).unwrap();
        assert!(!assertion_ok(
            ORIGIN,
            "abc",
            &der,
            &cd,
            &ad,
            &sign(&other, &cd, &ad)
        ));
        let mut bad = sig.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(!assertion_ok(ORIGIN, "abc", &der, &cd, &ad, &bad));
    }
}
