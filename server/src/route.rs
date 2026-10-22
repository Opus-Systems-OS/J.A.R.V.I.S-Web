//! `GET /web/route?to=&from=lat,lon`: driving directions for Jarvis's
//! `directions` tool. The destination is found by OpenStreetMap's Nominatim
//! (an address, a business or a place; at most one search a second, as its
//! policy asks), and the route comes from the public OSRM server: distance,
//! time, a simplified line for the globe and turn-by-turn steps. The start
//! is rounded to three decimals (about a hundred metres) before it leaves;
//! nothing is kept but a ten-minute cache in memory. Any unlocked profile.

use crate::error::{Error, Result};
use crate::intel::fetch;
use crate::AppState;
use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(10 * 60);
const MAX_CACHED: usize = 64;
const MAX_TO: usize = 200;
const MAX_LINE: usize = 2000;
const MAX_STEPS: usize = 60;
/// Nominatim's usage policy: an absolute maximum of one request a second.
const NOMINATIM_GAP: Duration = Duration::from_secs(1);

#[derive(Default)]
pub struct Routes {
    cache: Mutex<HashMap<String, (Instant, Route)>>,
    last_search: tokio::sync::Mutex<Option<Instant>>,
}

#[derive(Deserialize)]
pub struct Params {
    to: String,
    from: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Place {
    pub name: String,
    pub lat: f64,
    pub lon: f64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Step {
    pub text: String,
    pub distance_m: f64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Route {
    pub from: Place,
    pub to: Place,
    pub distance_m: f64,
    pub duration_s: f64,
    /// `[lon, lat]` pairs, as GeoJSON has them.
    pub line: Vec<[f64; 2]>,
    pub steps: Vec<Step>,
}

fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

/// `"34.16,-118.64"` → a position, or nothing.
pub fn parse_from(s: &str) -> Option<(f64, f64)> {
    let (a, b) = s.split_once(',')?;
    let (lat, lon) = (a.trim().parse::<f64>().ok()?, b.trim().parse::<f64>().ok()?);
    ((-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon))
        .then(|| (round3(lat), round3(lon)))
}

/// Whitespace collapsed; 1–200 characters, none of them control characters.
pub fn clean_to(s: &str) -> Option<String> {
    let q: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let n = q.chars().count();
    ((1..=MAX_TO).contains(&n) && !q.chars().any(char::is_control)).then_some(q)
}

pub async fn get(State(state): State<AppState>, Query(p): Query<Params>) -> Result<Json<Route>> {
    let to = clean_to(&p.to)
        .ok_or_else(|| Error::InvalidRequest(format!("to must be 1–{MAX_TO} characters")))?;
    let (lat, lon) =
        parse_from(&p.from).ok_or_else(|| Error::InvalidRequest("from must be lat,lon".into()))?;
    let key = format!("{lat:.3},{lon:.3}>{}", to.to_lowercase());
    let routes = &state.intel.routes;
    if let Some((at, r)) = routes.cache.lock().expect("routes").get(&key) {
        if at.elapsed() < TTL {
            return Ok(Json(r.clone()));
        }
    }
    let dest = search(&state, &to, lat, lon).await?;
    let url = format!(
        "https://router.project-osrm.org/route/v1/driving/{lon},{lat};{},{}?overview=simplified&geometries=geojson&steps=true",
        dest.lon, dest.lat
    );
    let body = fetch(&state.http, &url, "application/json")
        .await
        .map_err(|e| Error::Internal(format!("OSRM: {e}")))?;
    let mut route = parse_osrm(&body).ok_or_else(|| {
        Error::InvalidRequest(format!("I can't find a driving route to {}", dest.name))
    })?;
    route.from = Place {
        name: "your location".into(),
        lat,
        lon,
    };
    route.to = dest;
    let mut cache = routes.cache.lock().expect("routes");
    if cache.len() >= MAX_CACHED {
        cache.retain(|_, (at, _)| at.elapsed() < TTL);
    }
    if cache.len() < MAX_CACHED {
        cache.insert(key, (Instant::now(), route.clone()));
    }
    Ok(Json(route))
}

/// The best Nominatim match for `q`, nearer `lat, lon` preferred.
async fn search(state: &AppState, q: &str, lat: f64, lon: f64) -> Result<Place> {
    let viewbox = format!("{},{},{},{}", lon - 1.0, lat + 1.0, lon + 1.0, lat - 1.0);
    let url = reqwest::Url::parse_with_params(
        "https://nominatim.openstreetmap.org/search",
        &[
            ("format", "jsonv2"),
            ("q", q),
            ("limit", "1"),
            ("viewbox", &viewbox),
            ("bounded", "0"),
            ("accept-language", "en"),
        ],
    )
    .map_err(|e| Error::Internal(format!("search url: {e}")))?;
    {
        let mut last = state.intel.routes.last_search.lock().await;
        if let Some(wait) = last.and_then(|t| NOMINATIM_GAP.checked_sub(t.elapsed())) {
            tokio::time::sleep(wait).await;
        }
        *last = Some(Instant::now());
    }
    let body = fetch(&state.http, url.as_str(), "application/json")
        .await
        .map_err(|e| Error::Internal(format!("Nominatim: {e}")))?;
    parse_nominatim(&body).ok_or_else(|| Error::InvalidRequest(format!("I can't find {q}")))
}

pub fn parse_nominatim(body: &[u8]) -> Option<Place> {
    let v: Value = serde_json::from_slice(body).ok()?;
    let hit = v.as_array()?.first()?;
    let num = |k: &str| hit[k].as_str().and_then(|s| s.parse::<f64>().ok());
    Some(Place {
        name: hit["display_name"].as_str()?.to_owned(),
        lat: num("lat")?,
        lon: num("lon")?,
    })
}

/// OSRM's first route; `from` and `to` are filled in by the caller.
pub fn parse_osrm(body: &[u8]) -> Option<Route> {
    let v: Value = serde_json::from_slice(body).ok()?;
    if v["code"].as_str() != Some("Ok") {
        return None;
    }
    let r = v["routes"].as_array()?.first()?;
    let line: Vec<[f64; 2]> = r["geometry"]["coordinates"]
        .as_array()?
        .iter()
        .filter_map(|p| Some([p[0].as_f64()?, p[1].as_f64()?]))
        .take(MAX_LINE)
        .collect();
    let steps = r["legs"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|leg| leg["steps"].as_array().cloned().unwrap_or_default())
        .map(|s| Step {
            text: step_text(&s),
            distance_m: s["distance"].as_f64().unwrap_or(0.0).round(),
        })
        .take(MAX_STEPS)
        .collect();
    let blank = Place {
        name: String::new(),
        lat: 0.0,
        lon: 0.0,
    };
    Some(Route {
        from: blank.clone(),
        to: blank,
        distance_m: r["distance"].as_f64()?.round(),
        duration_s: r["duration"].as_f64()?.round(),
        line,
        steps,
    })
}

/// An OSRM step as a sentence: "Turn left onto Main Street".
pub fn step_text(s: &Value) -> String {
    let m = &s["maneuver"];
    let kind = m["type"].as_str().unwrap_or("");
    let modifier = m["modifier"].as_str().unwrap_or("");
    let name = s["name"].as_str().unwrap_or("").trim();
    let onto = if name.is_empty() {
        String::new()
    } else {
        format!(" onto {name}")
    };
    let on = if name.is_empty() {
        String::new()
    } else {
        format!(" on {name}")
    };
    let dir = if modifier.is_empty() {
        String::new()
    } else {
        format!(" {modifier}")
    };
    match kind {
        "depart" => format!("Head out{on}"),
        "arrive" => "Arrive at your destination".into(),
        "turn" | "end of road" => format!("Turn{dir}{onto}"),
        "new name" | "continue" => format!("Continue{dir}{onto}"),
        "merge" => format!("Merge{dir}{onto}"),
        "on ramp" => format!("Take the ramp{dir}{onto}"),
        "off ramp" => format!("Take the exit{dir}{onto}"),
        "fork" => format!("Keep{dir} at the fork{onto}"),
        "roundabout" | "rotary" => match m["exit"].as_u64() {
            Some(n) => format!("At the roundabout, take exit {n}{onto}"),
            None => format!("Go through the roundabout{onto}"),
        },
        _ => format!("Continue{dir}{onto}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn inputs_are_checked() {
        assert_eq!(parse_from("34.1612,-118.6389"), Some((34.161, -118.639)));
        assert_eq!(parse_from("91,0"), None);
        assert_eq!(parse_from("x,y"), None);
        assert_eq!(parse_from("34.1"), None);
        assert_eq!(clean_to("  LAX \n airport "), Some("LAX airport".into()));
        assert_eq!(clean_to("   "), None);
        assert_eq!(clean_to(&"a".repeat(201)), None);
    }

    #[test]
    fn nominatim_gives_the_first_match() {
        let body = br#"[{"lat":"33.9416","lon":"-118.4085","display_name":"Los Angeles International Airport, Los Angeles, California"}]"#;
        let p = parse_nominatim(body).unwrap();
        assert_eq!(p.lat, 33.9416);
        assert!(p.name.starts_with("Los Angeles International"));
        assert_eq!(parse_nominatim(b"[]"), None);
    }

    #[test]
    fn osrm_routes_become_lines_and_sentences() {
        let body = json!({"code":"Ok","routes":[{"distance":45210.4,"duration":2400.6,
          "geometry":{"coordinates":[[-118.64,34.16],[-118.5,34.1],[-118.41,33.94]]},
          "legs":[{"steps":[
            {"distance":120.0,"name":"Calabasas Road","maneuver":{"type":"depart"}},
            {"distance":800.2,"name":"US 101","maneuver":{"type":"on ramp","modifier":"right"}},
            {"distance":50.0,"name":"","maneuver":{"type":"roundabout","exit":2}},
            {"distance":0.0,"name":"World Way","maneuver":{"type":"arrive"}}]}]}]})
        .to_string();
        let r = parse_osrm(body.as_bytes()).unwrap();
        assert_eq!(r.distance_m, 45210.0);
        assert_eq!(r.duration_s, 2401.0);
        assert_eq!(r.line.len(), 3);
        let texts: Vec<&str> = r.steps.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(
            texts,
            [
                "Head out on Calabasas Road",
                "Take the ramp right onto US 101",
                "At the roundabout, take exit 2",
                "Arrive at your destination"
            ]
        );
        assert_eq!(parse_osrm(br#"{"code":"NoRoute"}"#), None);
    }
}
