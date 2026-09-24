//! `/web/credits` — what is left to spend, for the Usage tab, the banner and
//! the spoken warnings.
//!
//! Anthropic has no endpoint that returns a prepaid balance, so this keeps a
//! ledger: you type the Console balance after a top-up (the anchor), and
//! what is left is the anchor minus the fleet's list cost since then. That
//! is an estimate — list price, and a session that straddles the anchor
//! counts whole — and the page says so. Fish reports its own credit, read
//! through the API's `/v1/voice/credit`.
//!
//! Both upstream reads go through this site's own key, like `/bff`. One
//! failing never fails the other: its half carries `error` instead.

use crate::db::{CreditPatch, CreditSettings};
use crate::error::{Error, Result};
use crate::request_id::{RequestId, HEADER as REQUEST_ID};
use crate::AppState;
use axum::extract::rejection::JsonRejection;
use axum::extract::State;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

/// Upper bound on any amount typed here: $10,000.
const MAX_CENTS: i64 = 1_000_000;
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Serialize, PartialEq)]
pub struct Anthropic {
    /// The balance you typed, whole cents; `None` until you set one.
    pub anchor_cents: Option<i64>,
    /// RFC 3339.
    pub anchored_at: Option<String>,
    /// Fleet list cost since the anchor.
    pub spent_since_cents: Option<i64>,
    /// `anchor − spent`; may go negative (the estimate lags reality).
    pub remaining_cents: Option<i64>,
    pub warn_below_cents: i64,
    /// Remaining is under the threshold.
    pub low: bool,
    /// The fleet's most recent session ended on a billing error.
    pub exhausted: bool,
    /// When that session was observed, RFC 3339.
    pub billing_error_at: Option<String>,
    /// Always true: this is a ledger, not Anthropic's figure.
    pub estimate: bool,
    /// Why usage could not be read, when it could not.
    pub error: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Fish {
    /// US dollars as Fish reports them.
    pub credit_usd: Option<String>,
    pub warn_below_cents: i64,
    pub low: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Credits {
    pub anthropic: Anthropic,
    pub fish: Fish,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreditsUpdate {
    /// The Console balance, whole cents. Setting it stamps "now".
    pub anchor_cents: Option<i64>,
    pub anthropic_warn_cents: Option<i64>,
    pub fish_warn_cents: Option<i64>,
}

fn rfc3339(unix: i64) -> Option<String> {
    OffsetDateTime::from_unix_timestamp(unix)
        .ok()?
        .format(&Rfc3339)
        .ok()
}

/// Dollars as a decimal string → whole cents, rounded down.
fn usd_to_cents(usd: &str) -> Option<i64> {
    let v: f64 = usd.trim().parse().ok()?;
    v.is_finite().then(|| (v * 100.0).floor() as i64)
}

/// The Anthropic half, from the ledger row and `/v1/usage` (windowed at the
/// anchor when there is one).
pub fn anthropic(
    settings: &CreditSettings,
    usage: std::result::Result<&Value, String>,
) -> Anthropic {
    let mut out = Anthropic {
        anchor_cents: settings.anchor_cents,
        anchored_at: settings.anchored_at.and_then(rfc3339),
        spent_since_cents: None,
        remaining_cents: None,
        warn_below_cents: settings.anthropic_warn_cents,
        low: false,
        exhausted: false,
        billing_error_at: None,
        estimate: true,
        error: None,
    };
    let usage = match usage {
        Ok(u) => u,
        Err(e) => {
            out.error = Some(e);
            return out;
        }
    };
    // `recent` is most recently observed first. If the newest session died
    // on billing, the account is out; any later session that ran clears it.
    if let Some(newest) = usage["recent"].as_array().and_then(|r| r.first()) {
        let billing = newest["last_error"]
            .as_str()
            .is_some_and(|e| e.starts_with("billing_error"));
        if billing {
            out.exhausted = true;
            out.billing_error_at = newest["observed_at"].as_str().map(str::to_owned);
        }
    }
    if let Some(anchor) = settings.anchor_cents {
        let spent: i64 = usage["by_agent"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|r| r["total_list_cost_cents"].as_i64())
                    .sum()
            })
            .unwrap_or(0);
        let remaining = anchor - spent;
        out.spent_since_cents = Some(spent);
        out.remaining_cents = Some(remaining);
        out.low = remaining < settings.anthropic_warn_cents;
    }
    out
}

pub fn fish(settings: &CreditSettings, credit: std::result::Result<&Value, String>) -> Fish {
    let mut out = Fish {
        credit_usd: None,
        warn_below_cents: settings.fish_warn_cents,
        low: false,
        error: None,
    };
    match credit {
        Ok(v) => match v["credit_usd"].as_str() {
            Some(usd) => {
                out.low = usd_to_cents(usd).is_some_and(|c| c < settings.fish_warn_cents);
                out.credit_usd = Some(usd.to_owned());
            }
            None => out.error = Some("the API returned no credit".to_owned()),
        },
        Err(e) => out.error = Some(e),
    }
    out
}

/// GET `path_and_query` on the API with this site's key; the body, or a
/// one-line reason (the API's own error message when it sent one).
async fn api_get(
    state: &AppState,
    request_id: &str,
    path_and_query: &str,
) -> std::result::Result<Value, String> {
    let res = state
        .http
        .get(format!("{}{}", state.config.api_url, path_and_query))
        .bearer_auth(&state.config.api_key)
        .header(REQUEST_ID, request_id)
        .timeout(UPSTREAM_TIMEOUT)
        .send()
        .await
        .map_err(|_| "could not reach the Opus Systems OS API".to_owned())?;
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(body);
    }
    Err(body["error"]["message"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| format!("the API answered {}", status.as_u16())))
}

async fn read(state: &AppState, request_id: &str) -> Result<Credits> {
    let settings = state.db.credits()?;
    // UTC RFC 3339 (`…T…Z`) is query-safe as it stands.
    let usage_path = match settings.anchored_at.and_then(rfc3339) {
        Some(since) => format!("/v1/usage?since={since}"),
        None => "/v1/usage".to_owned(),
    };
    let (usage, credit) = tokio::join!(
        api_get(state, request_id, &usage_path),
        api_get(state, request_id, "/v1/voice/credit"),
    );
    Ok(Credits {
        anthropic: anthropic(&settings, usage.as_ref().map_err(Clone::clone)),
        fish: fish(&settings, credit.as_ref().map_err(Clone::clone)),
    })
}

pub async fn get(
    State(state): State<AppState>,
    Extension(RequestId(request_id)): Extension<RequestId>,
) -> Result<Json<Credits>> {
    Ok(Json(read(&state, &request_id).await?))
}

pub async fn update(
    State(state): State<AppState>,
    Extension(RequestId(request_id)): Extension<RequestId>,
    body: std::result::Result<Json<CreditsUpdate>, JsonRejection>,
) -> Result<Json<Credits>> {
    let Json(req) = body.map_err(|e| Error::InvalidRequest(e.body_text()))?;
    for (name, v) in [
        ("anchor_cents", req.anchor_cents),
        ("anthropic_warn_cents", req.anthropic_warn_cents),
        ("fish_warn_cents", req.fish_warn_cents),
    ] {
        if v.is_some_and(|c| !(0..=MAX_CENTS).contains(&c)) {
            return Err(Error::InvalidRequest(format!(
                "{name} must be whole cents from 0 to {MAX_CENTS}"
            )));
        }
    }
    state.db.set_credits(&CreditPatch {
        anchor_cents: req.anchor_cents,
        anthropic_warn_cents: req.anthropic_warn_cents,
        fish_warn_cents: req.fish_warn_cents,
    })?;
    if req.anchor_cents.is_some() {
        tracing::info!(anchor_cents = req.anchor_cents, "credit anchor set");
    }
    Ok(Json(read(&state, &request_id).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(anchor: Option<i64>) -> CreditSettings {
        CreditSettings {
            anchor_cents: anchor,
            anchored_at: anchor.map(|_| 1_790_000_000),
            anthropic_warn_cents: 1000,
            fish_warn_cents: 200,
        }
    }

    #[test]
    fn remaining_is_anchor_minus_fleet_spend() {
        let usage = json!({"by_agent": [
            {"agent_slug": "jarvis", "total_list_cost_cents": 100},
            {"agent_slug": "gpu-compute", "total_list_cost_cents": 50}
        ], "recent": []});
        let a = anthropic(&settings(Some(900)), Ok(&usage));
        assert_eq!(a.spent_since_cents, Some(150));
        assert_eq!(a.remaining_cents, Some(750));
        assert!(a.low && !a.exhausted && a.estimate);
        assert!(a.anchored_at.unwrap().ends_with('Z'));

        let a = anthropic(&settings(Some(5000)), Ok(&usage));
        assert!(!a.low);

        let a = anthropic(&settings(None), Ok(&usage));
        assert_eq!(
            (a.remaining_cents, a.low),
            (None, false),
            "no anchor, no verdict"
        );
    }

    #[test]
    fn exhausted_only_while_the_newest_session_died_on_billing() {
        let dead = json!({"by_agent": [], "recent": [
            {"session_id": "b", "last_error": "billing_error: credit balance is too low", "observed_at": "2026-09-24T10:00:00Z"},
            {"session_id": "a", "last_error": null, "observed_at": "2026-09-24T09:00:00Z"}
        ]});
        let a = anthropic(&settings(None), Ok(&dead));
        assert!(a.exhausted);
        assert_eq!(a.billing_error_at.as_deref(), Some("2026-09-24T10:00:00Z"));

        let recovered = json!({"by_agent": [], "recent": [
            {"session_id": "c", "last_error": null, "observed_at": "2026-09-24T11:00:00Z"},
            {"session_id": "b", "last_error": "billing_error: credit balance is too low", "observed_at": "2026-09-24T10:00:00Z"}
        ]});
        assert!(!anthropic(&settings(None), Ok(&recovered)).exhausted);

        let other = json!({"by_agent": [], "recent": [
            {"session_id": "d", "last_error": "overloaded_error: busy", "observed_at": "2026-09-24T12:00:00Z"}
        ]});
        assert!(!anthropic(&settings(None), Ok(&other)).exhausted);
    }

    #[test]
    fn a_failed_read_says_why_and_judges_nothing() {
        let a = anthropic(&settings(Some(100)), Err("the API answered 403".into()));
        assert_eq!(a.error.as_deref(), Some("the API answered 403"));
        assert!(!a.low && !a.exhausted);
        assert_eq!(a.anchor_cents, Some(100), "the ledger still shows");

        let f = fish(&settings(None), Err("voice credits are exhausted".into()));
        assert!(f.error.is_some() && !f.low);
    }

    #[test]
    fn fish_low_under_threshold() {
        let f = fish(&settings(None), Ok(&json!({"credit_usd": "1.99"})));
        assert!(f.low);
        assert_eq!(f.credit_usd.as_deref(), Some("1.99"));
        assert!(!fish(&settings(None), Ok(&json!({"credit_usd": "2.00"}))).low);
        assert!(!fish(&settings(None), Ok(&json!({"credit_usd": "nonsense"}))).low);
        assert_eq!(usd_to_cents("12.345"), Some(1234));
    }
}
