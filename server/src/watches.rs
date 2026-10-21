//! `/web/watches`: each profile's Intel watchlist — a word ("fire",
//! "Ukraine"), a place and radius ("within 50 mi of Calabasas"), or both.
//! The HUD holding the mic matches the feed against it and speaks what is
//! new; `seen` records what was said, so two HUDs never both say it and the
//! next unlock picks up what came in while none was open. Kept here so it
//! follows the profile across browsers.

use crate::config::Profile;
use crate::db::Watch;
use crate::error::{Error, Result};
use crate::AppState;
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};

const TEXT_MAX_CHARS: usize = 80;
const MAX_WATCHES: i64 = 50;
const MAX_RADIUS_KM: f64 = 2000.0;
/// Feed item ids are short hashes; one check marks at most a feed's worth.
const MAX_SEEN: usize = 300;
const ID_MAX_CHARS: usize = 128;

#[derive(Debug, Serialize)]
pub struct Watches {
    pub watches: Vec<Watch>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewWatch {
    pub term: Option<String>,
    /// The place's name as said, located by the page (its gazetteer, or
    /// where he is): `lat`, `lon` and `radius_km` come with it.
    pub place: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub radius_km: Option<f64>,
}

fn text(v: &Option<String>, what: &str) -> Result<Option<String>> {
    match v.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(t) if t.chars().count() > TEXT_MAX_CHARS || t.chars().any(char::is_control) => {
            Err(Error::InvalidRequest(format!(
                "{what} must be 1–{TEXT_MAX_CHARS} plain characters"
            )))
        }
        Some(t) => Ok(Some(t.to_owned())),
    }
}

pub fn validate(req: &NewWatch, now: i64) -> Result<Watch> {
    let term = text(&req.term, "term")?;
    let place = text(&req.place, "place")?;
    let (lat, lon, radius_km) = match (&place, req.lat, req.lon, req.radius_km) {
        (None, None, None, None) => (None, None, None),
        (Some(_), Some(lat), Some(lon), Some(r))
            if (-90.0..=90.0).contains(&lat)
                && (-180.0..=180.0).contains(&lon)
                && r > 0.0
                && r <= MAX_RADIUS_KM =>
        {
            (Some(lat), Some(lon), Some(r))
        }
        _ => {
            return Err(Error::InvalidRequest(format!(
                "a place needs lat, lon and radius_km (up to {MAX_RADIUS_KM} km)"
            )))
        }
    };
    if term.is_none() && place.is_none() {
        return Err(Error::InvalidRequest(
            "give a term, a place, or both".into(),
        ));
    }
    Ok(Watch {
        id: 0,
        term,
        place,
        lat,
        lon,
        radius_km,
        created_at: now,
    })
}

pub async fn list(
    State(state): State<AppState>,
    Extension(profile): Extension<Profile>,
) -> Result<Json<Watches>> {
    Ok(Json(Watches {
        watches: state.db.watches(&profile.id)?,
    }))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(profile): Extension<Profile>,
    body: std::result::Result<Json<NewWatch>, JsonRejection>,
) -> Result<Json<Watch>> {
    let Json(req) = body.map_err(|e| Error::InvalidRequest(e.body_text()))?;
    let mut w = validate(&req, crate::db::now())?;
    w.id = state
        .db
        .add_watch(&profile.id, &w, MAX_WATCHES)?
        .ok_or_else(|| Error::InvalidRequest(format!("at most {MAX_WATCHES} watches")))?;
    Ok(Json(w))
}

pub async fn remove(
    State(state): State<AppState>,
    Extension(profile): Extension<Profile>,
    Path(id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    if !state.db.remove_watch(&profile.id, id)? {
        return Err(Error::NotFound);
    }
    Ok(Json(serde_json::json!({ "id": id, "removed": true })))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Seen {
    pub items: Vec<String>,
}

/// `POST /web/watches/seen {items}` → `{new}`: the items not announced
/// before, now marked. Only those are spoken.
pub async fn seen(
    State(state): State<AppState>,
    Extension(profile): Extension<Profile>,
    body: std::result::Result<Json<Seen>, JsonRejection>,
) -> Result<Json<serde_json::Value>> {
    let Json(req) = body.map_err(|e| Error::InvalidRequest(e.body_text()))?;
    if req.items.len() > MAX_SEEN
        || req
            .items
            .iter()
            .any(|i| i.is_empty() || i.chars().count() > ID_MAX_CHARS)
    {
        return Err(Error::InvalidRequest(format!(
            "items: at most {MAX_SEEN} ids of 1–{ID_MAX_CHARS} characters"
        )));
    }
    let fresh = state.db.mark_alerted(&profile.id, &req.items)?;
    Ok(Json(serde_json::json!({ "new": fresh })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(term: Option<&str>, place: Option<&str>, geo: Option<(f64, f64, f64)>) -> NewWatch {
        NewWatch {
            term: term.map(Into::into),
            place: place.map(Into::into),
            lat: geo.map(|g| g.0),
            lon: geo.map(|g| g.1),
            radius_km: geo.map(|g| g.2),
        }
    }

    #[test]
    fn watches_are_checked() {
        assert!(validate(&req(Some(" fire "), None, None), 1)
            .is_ok_and(|w| w.term.as_deref() == Some("fire")));
        assert!(validate(
            &req(
                Some("fire"),
                Some("Calabasas"),
                Some((34.16, -118.64, 80.0))
            ),
            1
        )
        .is_ok());
        assert!(validate(
            &req(None, Some("Calabasas"), Some((34.16, -118.64, 80.0))),
            1
        )
        .is_ok());
        assert!(validate(&req(None, None, None), 1).is_err(), "nothing");
        assert!(validate(&req(Some("  "), None, None), 1).is_err(), "blank");
        assert!(
            validate(&req(None, Some("Calabasas"), None), 1).is_err(),
            "place, no geo"
        );
        assert!(
            validate(&req(Some("x"), None, Some((1.0, 1.0, 10.0))), 1).is_err(),
            "geo, no place"
        );
        assert!(validate(&req(None, Some("x"), Some((91.0, 0.0, 10.0))), 1).is_err());
        assert!(validate(&req(None, Some("x"), Some((0.0, 0.0, 0.0))), 1).is_err());
        assert!(validate(&req(None, Some("x"), Some((0.0, 0.0, 5000.0))), 1).is_err());
        assert!(validate(&req(Some(&"x".repeat(81)), None, None), 1).is_err());
        assert!(validate(&req(Some("a\nb"), None, None), 1).is_err());
    }
}
