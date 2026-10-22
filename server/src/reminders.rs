//! `/web/reminders` and `/web/visit` — the two things the briefing needs
//! that no API holds: reminders Jarvis sets for you (spoken by the HUD when
//! due, or at the next unlock if no HUD was open), and when you last opened
//! the HUD (so the greeting can say what changed since). Also notes and
//! tasks captured without a time.
//!
//! Time zones live in the HUD (the browser has the tz database): it works out
//! a recurring reminder's next time and holds reminders in quiet hours. Here
//! the rule is only stored and checked.

use crate::config::Profile;
use crate::db::{Note, Reminder};
use crate::error::{Error, Result};
use crate::AppState;
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

const TEXT_MAX_CHARS: usize = 300;
/// Reminders further out than this are almost certainly a misheard date.
const MAX_AHEAD_SECS: i64 = 366 * 86_400;
/// A time a little in the past (the model's clock, rounding) is "now".
const PAST_GRACE_SECS: i64 = 120;
const SNOOZE_MINUTES: i64 = 10;

#[derive(Debug, Serialize, PartialEq)]
pub struct ReminderOut {
    pub id: i64,
    pub text: String,
    /// RFC 3339, UTC.
    pub due_at: String,
    /// Due now or overdue.
    pub due: bool,
    /// A recurring reminder's rule, e.g. `weekdays`, and its wall time.
    pub repeat: Option<String>,
    pub wall: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Reminders {
    pub reminders: Vec<ReminderOut>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewReminder {
    pub text: String,
    /// RFC 3339 with an offset, e.g. `2026-09-29T09:00:00-07:00`. For a
    /// recurring reminder, the first time, in his zone: its wall time repeats.
    pub at: String,
    /// `daily`, `weekdays`, `weekly:1,3,5` (0 = Sunday) or `every:N` (days).
    #[serde(default)]
    pub repeat: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Delivered {
    /// A recurring reminder's next time, RFC 3339.
    #[serde(default)]
    pub next_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snooze {
    /// The reminder to repeat; the one spoken last if not given.
    #[serde(default)]
    pub id: Option<i64>,
    #[serde(default)]
    pub minutes: Option<i64>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct NoteOut {
    pub id: i64,
    /// `note` or `task`.
    pub kind: String,
    pub text: String,
    /// RFC 3339, UTC.
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct Notes {
    pub notes: Vec<NoteOut>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewNote {
    pub text: String,
    /// `note` (the default) or `task`.
    #[serde(default)]
    pub kind: Option<String>,
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
        repeat: r.recur.clone(),
        wall: r.wall.clone(),
    }
}

fn note_out(n: &Note) -> NoteOut {
    NoteOut {
        id: n.id,
        kind: n.kind.clone(),
        text: n.text.clone(),
        created_at: rfc3339(n.created_at),
    }
}

fn check_text(text: &str) -> Result<&str> {
    let text = text.trim();
    if text.is_empty() || text.chars().count() > TEXT_MAX_CHARS {
        return Err(Error::InvalidRequest(format!(
            "text must be 1–{TEXT_MAX_CHARS} characters"
        )));
    }
    Ok(text)
}

fn parse_at(at: &str) -> Result<i64> {
    Ok(OffsetDateTime::parse(at.trim(), &Rfc3339)
        .map_err(|_| {
            Error::InvalidRequest(
                "at must be RFC 3339 with an offset, e.g. 2026-09-29T09:00:00-07:00".into(),
            )
        })?
        .unix_timestamp())
}

/// `daily`, `weekdays`, `weekly:1,3,5` (days 0–6, 0 = Sunday) or `every:N`
/// (1–365 days).
pub fn valid_recur(rule: &str) -> bool {
    match rule.split_once(':') {
        None => matches!(rule, "daily" | "weekdays"),
        Some(("weekly", days)) => days
            .split(',')
            .all(|d| matches!(d.parse::<u8>(), Ok(0..=6))),
        Some(("every", n)) => matches!(n.parse::<u16>(), Ok(1..=365)),
        Some(_) => false,
    }
}

/// A recurring reminder's rule and wall time (`HH:MM` from `at`, which the
/// HUD sends as his local time); `None` for a one-off.
pub fn repeat_of(req: &NewReminder) -> Result<Option<(String, String)>> {
    let Some(rule) = req.repeat.as_deref().map(str::trim) else {
        return Ok(None);
    };
    if !valid_recur(rule) {
        return Err(Error::InvalidRequest(
            "repeat must be daily, weekdays, weekly:1,3,5 (0 = Sunday) or every:N (days)".into(),
        ));
    }
    let wall = req.at.trim().get(11..16).unwrap_or_default();
    let b = wall.as_bytes();
    if b.len() != 5
        || b[2] != b':'
        || !b
            .iter()
            .enumerate()
            .all(|(i, c)| i == 2 || c.is_ascii_digit())
    {
        return Err(Error::InvalidRequest(
            "at must be RFC 3339 with an offset".into(),
        ));
    }
    Ok(Some((rule.to_owned(), wall.to_owned())))
}

/// Check a new reminder; its due time in unix seconds.
pub fn validate(req: &NewReminder, now: i64) -> Result<i64> {
    check_text(&req.text)?;
    let at = parse_at(&req.at)?;
    if at < now - PAST_GRACE_SECS {
        return Err(Error::InvalidRequest("that time has already passed".into()));
    }
    if at > now + MAX_AHEAD_SECS {
        return Err(Error::InvalidRequest("at most a year ahead".into()));
    }
    Ok(at.max(now))
}

pub async fn list(
    State(state): State<AppState>,
    Extension(profile): Extension<Profile>,
) -> Result<Json<Reminders>> {
    let now = crate::db::now();
    Ok(Json(Reminders {
        reminders: state
            .db
            .pending_reminders(&profile.id)?
            .iter()
            .map(|r| out(r, now))
            .collect(),
    }))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(profile): Extension<Profile>,
    body: std::result::Result<Json<NewReminder>, JsonRejection>,
) -> Result<Json<ReminderOut>> {
    let Json(req) = body.map_err(|e| Error::InvalidRequest(e.body_text()))?;
    let now = crate::db::now();
    let due_at = validate(&req, now)?;
    let repeat = repeat_of(&req)?;
    let text = req.text.trim().to_owned();
    let id = state.db.add_reminder(
        &profile.id,
        &text,
        due_at,
        repeat.as_ref().map(|(r, w)| (r.as_str(), w.as_str())),
    )?;
    // The time, never the words: a reminder can be personal.
    tracing::info!(
        id,
        due_in_secs = due_at - now,
        recurs = repeat.is_some(),
        "reminder set"
    );
    let (recur, wall) = repeat.unzip();
    Ok(Json(out(
        &Reminder {
            id,
            text,
            due_at,
            created_at: now,
            recur,
            wall,
        },
        now,
    )))
}

pub async fn cancel(
    State(state): State<AppState>,
    Extension(profile): Extension<Profile>,
    Path(id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    close(&state, &profile, id, false)
}

/// Spoken: a one-off closes, a recurring one moves on to `next_at`.
pub async fn delivered(
    State(state): State<AppState>,
    Extension(profile): Extension<Profile>,
    Path(id): Path<i64>,
    body: std::result::Result<Json<Delivered>, JsonRejection>,
) -> Result<Json<serde_json::Value>> {
    let Json(req) = body.map_err(|e| Error::InvalidRequest(e.body_text()))?;
    if state.db.reminder_recurs(&profile.id, id)? != Some(true) {
        return close(&state, &profile, id, true);
    }
    let next_at = req
        .next_at
        .ok_or_else(|| Error::InvalidRequest("a recurring reminder needs next_at".into()))?;
    let now = crate::db::now();
    let next = parse_at(&next_at)?;
    if next <= now || next > now + MAX_AHEAD_SECS {
        return Err(Error::InvalidRequest(
            "next_at must be ahead, within a year".into(),
        ));
    }
    if !state.db.advance_reminder(&profile.id, id, next)? {
        return Err(Error::NotFound);
    }
    Ok(Json(
        serde_json::json!({ "id": id, "closed": false, "due_at": rfc3339(next) }),
    ))
}

/// Say it again in a few minutes: a one-off copy of it, so a recurring
/// reminder keeps its own schedule.
pub async fn snooze(
    State(state): State<AppState>,
    Extension(profile): Extension<Profile>,
    body: std::result::Result<Json<Snooze>, JsonRejection>,
) -> Result<Json<ReminderOut>> {
    let Json(req) = body.map_err(|e| Error::InvalidRequest(e.body_text()))?;
    let minutes = req.minutes.unwrap_or(SNOOZE_MINUTES);
    if !(1..=1440).contains(&minutes) {
        return Err(Error::InvalidRequest("minutes must be 1–1440".into()));
    }
    let text = state
        .db
        .snooze_source(&profile.id, req.id)?
        .ok_or(Error::NotFound)?;
    let now = crate::db::now();
    let due_at = now + minutes * 60;
    let id = state.db.add_reminder(&profile.id, &text, due_at, None)?;
    tracing::info!(id, minutes, "reminder snoozed");
    Ok(Json(out(
        &Reminder {
            id,
            text,
            due_at,
            created_at: now,
            recur: None,
            wall: None,
        },
        now,
    )))
}

pub async fn notes(
    State(state): State<AppState>,
    Extension(profile): Extension<Profile>,
) -> Result<Json<Notes>> {
    Ok(Json(Notes {
        notes: state
            .db
            .open_notes(&profile.id)?
            .iter()
            .map(note_out)
            .collect(),
    }))
}

pub async fn add_note(
    State(state): State<AppState>,
    Extension(profile): Extension<Profile>,
    body: std::result::Result<Json<NewNote>, JsonRejection>,
) -> Result<Json<NoteOut>> {
    let Json(req) = body.map_err(|e| Error::InvalidRequest(e.body_text()))?;
    let text = check_text(&req.text)?.to_owned();
    let kind = req.kind.as_deref().unwrap_or("note");
    if !matches!(kind, "note" | "task") {
        return Err(Error::InvalidRequest("kind must be note or task".into()));
    }
    let id = state.db.add_note(&profile.id, kind, &text)?;
    tracing::info!(id, kind, "note taken");
    Ok(Json(note_out(&Note {
        id,
        kind: kind.to_owned(),
        text,
        created_at: crate::db::now(),
    })))
}

pub async fn close_note(
    State(state): State<AppState>,
    Extension(profile): Extension<Profile>,
    Path(id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    if !state.db.close_note(&profile.id, id)? {
        return Err(Error::NotFound);
    }
    Ok(Json(serde_json::json!({ "id": id, "closed": true })))
}

fn close(
    state: &AppState,
    profile: &Profile,
    id: i64,
    delivered: bool,
) -> Result<Json<serde_json::Value>> {
    if !state.db.close_reminder(&profile.id, id, delivered)? {
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
pub async fn visit(
    State(state): State<AppState>,
    Extension(profile): Extension<Profile>,
) -> Result<Json<Visit>> {
    Ok(Json(Visit {
        previous: state.db.visit(&profile.id)?.map(rfc3339),
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
            repeat: None,
        }
    }

    #[test]
    fn repeat_rules_are_checked() {
        for ok in [
            "daily",
            "weekdays",
            "weekly:1",
            "weekly:0,3,6",
            "every:1",
            "every:365",
        ] {
            assert!(valid_recur(ok), "{ok}");
        }
        for bad in [
            "",
            "hourly",
            "weekly:",
            "weekly:7",
            "weekly:1,,2",
            "every:0",
            "every:366",
            "every:x",
            "daily:1",
        ] {
            assert!(!valid_recur(bad), "{bad}");
        }
        let mut r = req("vitamins", "2026-09-22T08:00:00-07:00");
        assert_eq!(repeat_of(&r).unwrap(), None);
        r.repeat = Some("weekdays".into());
        assert_eq!(
            repeat_of(&r).unwrap(),
            Some(("weekdays".into(), "08:00".into()))
        );
        r.repeat = Some("monthly".into());
        assert!(repeat_of(&r).is_err());
        r.repeat = Some("daily".into());
        r.at = "soon".into();
        assert!(repeat_of(&r).is_err());
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
            recur: None,
            wall: None,
        };
        assert!(out(&r, NOW).due);
        assert!(!out(&r, NOW - 1).due);
        assert_eq!(out(&r, NOW).due_at, "2026-09-21T14:13:20Z");
    }
}
