//! `/web/reminders` and `/web/visit` — the two things the briefing needs
//! that no API holds: reminders Jarvis sets for you (spoken by the HUD when
//! due, or at the next unlock if no HUD was open), and when you last opened
//! the HUD (so the greeting can say what changed since).

use crate::db::Reminder;
use crate::error::{Error, Result};
use crate::AppState;
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

const TEXT_MAX_CHARS: usize = 300;
/// Reminders further out than this are almost certainly a misheard date.
const MAX_AHEAD_SECS: i64 = 366 * 86_400;
/// A time a little in the past (the model's clock, rounding) is "now".
const PAST_GRACE_SECS: i64 = 120;

#[derive(Debug, Serialize, PartialEq)]
pub struct ReminderOut {
    pub id: i64,
    pub text: String,
    /// RFC 3339, UTC.
    pub due_at: String,
    /// Due now or overdue.
    pub due: bool,
}

#[derive(Debug, Serialize)]
pub struct Reminders {
    pub reminders: Vec<ReminderOut>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewReminder {
    pub text: String,
    /// RFC 3339 with an offset, e.g. `2026-09-29T09:00:00-07:00`.
    pub at: String,
}

fn rfc3339(unix: i64) -> String {
    OffsetDateTime::from_unix_timestamp(unix)
        .ok()
        .and_then(|t| t.format(&Rfc3339).ok())
        .unwrap_or_default()
}

pub fn out(r: &Reminder, now: i64) -> ReminderOut {
    ReminderOut {
        id: r.id,
        text: r.text.clone(),
        due_at: rfc3339(r.due_at),
        due: r.due_at <= now,
    }
}

/// Check a new reminder; its due time in unix seconds.
pub fn validate(req: &NewReminder, now: i64) -> Result<i64> {
    let text = req.text.trim();
    if text.is_empty() || text.chars().count() > TEXT_MAX_CHARS {
        return Err(Error::InvalidRequest(format!(
            "text must be 1–{TEXT_MAX_CHARS} characters"
        )));
    }
    let at = OffsetDateTime::parse(req.at.trim(), &Rfc3339)
        .map_err(|_| {
            Error::InvalidRequest(
                "at must be RFC 3339 with an offset, e.g. 2026-09-29T09:00:00-07:00".into(),
            )
        })?
        .unix_timestamp();
    if at < now - PAST_GRACE_SECS {
        return Err(Error::InvalidRequest("that time has already passed".into()));
    }
    if at > now + MAX_AHEAD_SECS {
        return Err(Error::InvalidRequest("at most a year ahead".into()));
    }
    Ok(at.max(now))
}

pub async fn list(State(state): State<AppState>) -> Result<Json<Reminders>> {
    let now = crate::db::now();
    Ok(Json(Reminders {
        reminders: state
            .db
            .pending_reminders()?
            .iter()
            .map(|r| out(r, now))
            .collect(),
    }))
}

pub async fn create(
    State(state): State<AppState>,
    body: std::result::Result<Json<NewReminder>, JsonRejection>,
) -> Result<Json<ReminderOut>> {
    let Json(req) = body.map_err(|e| Error::InvalidRequest(e.body_text()))?;
    let now = crate::db::now();
    let due_at = validate(&req, now)?;
    let text = req.text.trim().to_owned();
    let id = state.db.add_reminder(&text, due_at)?;
    // The time, never the words: a reminder can be personal.
    tracing::info!(id, due_in_secs = due_at - now, "reminder set");
    Ok(Json(out(
        &Reminder {
            id,
            text,
            due_at,
            created_at: now,
        },
        now,
    )))
}

pub async fn cancel(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    close(&state, id, false)
}

pub async fn delivered(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    close(&state, id, true)
}

fn close(state: &AppState, id: i64, delivered: bool) -> Result<Json<serde_json::Value>> {
    if !state.db.close_reminder(id, delivered)? {
        return Err(Error::NotFound);
    }
    Ok(Json(serde_json::json!({ "id": id, "closed": true })))
}

#[derive(Debug, Serialize)]
pub struct Visit {
    /// RFC 3339: when the HUD was opened before this, if ever.
    pub previous: Option<String>,
}

/// Called once per unlock: returns the last visit and records this one.
pub async fn visit(State(state): State<AppState>) -> Result<Json<Visit>> {
    Ok(Json(Visit {
        previous: state.db.visit()?.map(rfc3339),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_000_000; // 2026-09-21T14:13:20Z

    fn req(text: &str, at: &str) -> NewReminder {
        NewReminder {
            text: text.into(),
            at: at.into(),
        }
    }

    #[test]
    fn reminder_times_are_checked() {
        assert_eq!(
            validate(&req("call Josh", "2026-09-21T08:00:00-07:00"), NOW).unwrap(),
            NOW + 46 * 60 + 40
        );
        // A minute late is "now".
        assert_eq!(
            validate(&req("x", "2026-09-21T14:12:30Z"), NOW).unwrap(),
            NOW
        );
        assert!(
            validate(&req("x", "2026-09-21T10:00:00Z"), NOW).is_err(),
            "past"
        );
        assert!(
            validate(&req("x", "2028-01-01T00:00:00Z"), NOW).is_err(),
            "too far"
        );
        assert!(validate(&req("x", "tomorrow at 9"), NOW).is_err());
        assert!(
            validate(&req("x", "2026-09-22T09:00:00"), NOW).is_err(),
            "no offset"
        );
        assert!(validate(&req("  ", "2026-09-22T09:00:00Z"), NOW).is_err());
    }

    #[test]
    fn due_is_now_or_before() {
        let r = Reminder {
            id: 1,
            text: "t".into(),
            due_at: NOW,
            created_at: NOW - 10,
        };
        assert!(out(&r, NOW).due);
        assert!(!out(&r, NOW - 1).due);
        assert_eq!(out(&r, NOW).due_at, "2026-09-21T14:13:20Z");
    }
}
