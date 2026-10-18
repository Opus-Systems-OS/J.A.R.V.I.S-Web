//! `/web/local`: where the user is, so Jarvis isn't stuck in Calabasas. The
//! page asks the browser for its position (the browser prompts for it) or
//! takes a place he names, and this turns either into a place name, that
//! place's time zone and the weather there:
//!
//! - `GET /web/local?lat=&lon=`: named by OpenStreetMap's Nominatim.
//! - `GET /web/local?q=Austin, TX`: found by Open-Meteo's geocoder.
//!
//! The weather is Open-Meteo's forecast (no key) in the place's own time
//! zone, in the shape the briefing's weather row has. Coordinates are
//! rounded to three decimals (about a hundred metres) before they leave, and nothing
//! is kept but a ten-minute cache in memory. Any unlocked profile may ask.

use crate::error::{Error, Result};
use crate::intel::fetch;
use crate::AppState;
use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(10 * 60);
const MAX_CACHED: usize = 64;
const MAX_QUERY: usize = 80;

/// Recent answers, by rounded position or lowercased query.
#[derive(Default)]
pub struct Cache(Mutex<HashMap<String, (Instant, Local)>>);

#[derive(Deserialize)]
pub struct Params {
    lat: Option<f64>,
    lon: Option<f64>,
    q: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Local {
    /// "Calabasas", or none when the position couldn't be named.
    pub place: Option<String>,
    /// State or province: "California".
    pub region: Option<String>,
    /// ISO code: "US".
    pub country: Option<String>,
    pub lat: f64,
    pub lon: f64,
    /// IANA zone, e.g. `America/Chicago`; none if the forecast failed.
    pub time_zone: Option<String>,
    /// The briefing's weather detail (`temperature_f`, `conditions`, …).
    pub weather: Option<Value>,
}

pub async fn get(State(state): State<AppState>, Query(p): Query<Params>) -> Result<Json<Local>> {
    let key = match (&p.q, p.lat, p.lon) {
        (Some(q), _, _) => {
            let q = clean_query(q).ok_or_else(|| {
                Error::InvalidRequest(format!("q must be 1–{MAX_QUERY} characters"))
            })?;
            format!("q:{}", q.to_lowercase())
        }
        (None, Some(lat), Some(lon))
            if (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon) =>
        {
            format!("ll:{:.3},{:.3}", lat, lon)
        }
        _ => return Err(Error::InvalidRequest("give lat and lon, or q".into())),
    };
    if let Some(hit) = cached(&state.local, &key) {
        return Ok(Json(hit));
    }

    let http = &state.http;
    let mut local = match &p.q {
        Some(q) => {
            let q = clean_query(q).unwrap_or_default();
            let (name, hint) = split_hint(&q);
            let url = reqwest::Url::parse_with_params(
                "https://geocoding-api.open-meteo.com/v1/search",
                &[
                    ("name", name),
                    ("count", "10"),
                    ("language", "en"),
                    ("format", "json"),
                ],
            )
            .map_err(|e| Error::Internal(format!("geocode url: {e}")))?;
            let body = fetch(http, url.as_str(), "application/json")
                .await
                .map_err(|e| Error::Internal(format!("Open-Meteo geocoding: {e}")))?;
            let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            pick_place(&v, hint)
                .ok_or_else(|| Error::InvalidRequest(format!("I can't find a place called {q}")))?
        }
        None => {
            let (lat, lon) = (round3(p.lat.unwrap_or(0.0)), round3(p.lon.unwrap_or(0.0)));
            let url = reqwest::Url::parse_with_params(
                "https://nominatim.openstreetmap.org/reverse",
                &[
                    ("format", "jsonv2"),
                    ("lat", &lat.to_string()),
                    ("lon", &lon.to_string()),
                    ("zoom", "13"),
                    ("addressdetails", "1"),
                    ("accept-language", "en"),
                ],
            )
            .map_err(|e| Error::Internal(format!("reverse url: {e}")))?;
            // Unnamed is still useful: the weather and time zone don't need a name.
            let named = match fetch(http, url.as_str(), "application/json").await {
                Ok(b) => serde_json::from_slice::<Value>(&b)
                    .ok()
                    .map(|v| name_of(&v)),
                Err(e) => {
                    tracing::warn!(error = %e, "nominatim reverse failed");
                    None
                }
            };
            let (place, region, country) = named.unwrap_or_default();
            Local {
                place,
                region,
                country,
                lat,
                lon,
                time_zone: None,
                weather: None,
            }
        }
    };

    let url = reqwest::Url::parse_with_params(
        "https://api.open-meteo.com/v1/forecast",
        &[
            ("latitude", local.lat.to_string().as_str()),
            ("longitude", local.lon.to_string().as_str()),
            ("current", "temperature_2m,weather_code,wind_speed_10m"),
            (
                "daily",
                "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
            ),
            ("temperature_unit", "fahrenheit"),
            ("wind_speed_unit", "mph"),
            ("timezone", "auto"),
            ("forecast_days", "1"),
        ],
    )
    .map_err(|e| Error::Internal(format!("forecast url: {e}")))?;
    match fetch(http, url.as_str(), "application/json").await {
        Ok(b) => {
            let v: Value = serde_json::from_slice(&b).unwrap_or(Value::Null);
            if local.time_zone.is_none() {
                local.time_zone = v["timezone"]
                    .as_str()
                    .filter(|z| z.contains('/'))
                    .map(str::to_owned);
            }
            local.weather = weather(&v, local.place.as_deref());
        }
        Err(e) => tracing::warn!(error = %e, "open-meteo forecast failed"),
    }

    let mut cache = state.local.0.lock().expect("local cache");
    if cache.len() >= MAX_CACHED {
        cache.retain(|_, (at, _)| at.elapsed() < TTL);
        if cache.len() >= MAX_CACHED {
            cache.clear();
        }
    }
    cache.insert(key, (Instant::now(), local.clone()));
    Ok(Json(local))
}

fn cached(cache: &Cache, key: &str) -> Option<Local> {
    let cache = cache.0.lock().expect("local cache");
    cache
        .get(key)
        .filter(|(at, _)| at.elapsed() < TTL)
        .map(|(_, l)| l.clone())
}

fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

fn clean_query(q: &str) -> Option<String> {
    let q: String = q.split_whitespace().collect::<Vec<_>>().join(" ");
    let n = q.chars().count();
    (1..=MAX_QUERY).contains(&n).then_some(q)
}

/// "Austin, TX" → ("Austin", Some("TX")): the geocoder matches names only.
fn split_hint(q: &str) -> (&str, Option<&str>) {
    match q.split_once(',') {
        Some((name, rest)) if !rest.trim().is_empty() => (name.trim(), Some(rest.trim())),
        _ => (q.trim_end_matches(',').trim(), None),
    }
}

/// Nominatim's reverse answer → (place, region, country code).
pub fn name_of(v: &Value) -> (Option<String>, Option<String>, Option<String>) {
    let a = &v["address"];
    let s = |k: &str| a[k].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    // The part of a big city he'd name ("Woodland Hills", not "Los Angeles").
    let place = [
        "town",
        "village",
        "suburb",
        "city",
        "hamlet",
        "municipality",
        "county",
    ]
    .iter()
    .find_map(|k| s(k));
    let region = s("state").or_else(|| s("province")).or_else(|| s("region"));
    let country = s("country_code").map(|c| c.to_uppercase());
    (place, region, country)
}

/// The geocoder's results → the first one, or the first matching the hint
/// ("TX", "Texas", "UK", "Canada") when he gave one.
pub fn pick_place(v: &Value, hint: Option<&str>) -> Option<Local> {
    let results = v["results"].as_array()?;
    let hint = hint
        .map(|h| h.trim().to_lowercase())
        .filter(|h| !h.is_empty());
    let matches = |r: &Value| {
        let Some(h) = &hint else { return true };
        let admin = r["admin1"].as_str().unwrap_or("").to_lowercase();
        let country = r["country"].as_str().unwrap_or("").to_lowercase();
        let code = r["country_code"].as_str().unwrap_or("").to_lowercase();
        let state = us_state(h).map(str::to_lowercase);
        admin == *h
            || country == *h
            || code == *h
            || (h == "uk" && code == "gb")
            || (h == "usa" && code == "us")
            || state.is_some_and(|s| code == "us" && admin == s)
    };
    let r = results
        .iter()
        .find(|r| matches(r))
        .or_else(|| hint.is_none().then(|| results.first()).flatten())?;
    let s = |k: &str| r[k].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    Some(Local {
        place: s("name"),
        region: s("admin1"),
        country: s("country_code").map(|c| c.to_uppercase()),
        lat: r["latitude"].as_f64()?,
        lon: r["longitude"].as_f64()?,
        time_zone: s("timezone").filter(|z| z.contains('/')),
        weather: None,
    })
}

/// "tx" → "Texas".
fn us_state(code: &str) -> Option<&'static str> {
    const STATES: &[(&str, &str)] = &[
        ("al", "Alabama"),
        ("ak", "Alaska"),
        ("az", "Arizona"),
        ("ar", "Arkansas"),
        ("ca", "California"),
        ("co", "Colorado"),
        ("ct", "Connecticut"),
        ("de", "Delaware"),
        ("dc", "District of Columbia"),
        ("fl", "Florida"),
        ("ga", "Georgia"),
        ("hi", "Hawaii"),
        ("id", "Idaho"),
        ("il", "Illinois"),
        ("in", "Indiana"),
        ("ia", "Iowa"),
        ("ks", "Kansas"),
        ("ky", "Kentucky"),
        ("la", "Louisiana"),
        ("me", "Maine"),
        ("md", "Maryland"),
        ("ma", "Massachusetts"),
        ("mi", "Michigan"),
        ("mn", "Minnesota"),
        ("ms", "Mississippi"),
        ("mo", "Missouri"),
        ("mt", "Montana"),
        ("ne", "Nebraska"),
        ("nv", "Nevada"),
        ("nh", "New Hampshire"),
        ("nj", "New Jersey"),
        ("nm", "New Mexico"),
        ("ny", "New York"),
        ("nc", "North Carolina"),
        ("nd", "North Dakota"),
        ("oh", "Ohio"),
        ("ok", "Oklahoma"),
        ("or", "Oregon"),
        ("pa", "Pennsylvania"),
        ("ri", "Rhode Island"),
        ("sc", "South Carolina"),
        ("sd", "South Dakota"),
        ("tn", "Tennessee"),
        ("tx", "Texas"),
        ("ut", "Utah"),
        ("vt", "Vermont"),
        ("va", "Virginia"),
        ("wa", "Washington"),
        ("wv", "West Virginia"),
        ("wi", "Wisconsin"),
        ("wy", "Wyoming"),
    ];
    STATES.iter().find(|(c, _)| *c == code).map(|(_, n)| *n)
}

/// The forecast → the briefing's weather detail, or none without a current
/// temperature.
pub fn weather(v: &Value, place: Option<&str>) -> Option<Value> {
    let num = |p: &str| v.pointer(p).and_then(Value::as_f64).map(f64::round);
    let temp = num("/current/temperature_2m")?;
    let code = v
        .pointer("/current/weather_code")
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    Some(json!({
        "place": place,
        "temperature_f": temp,
        "conditions": describe(code),
        "weather_code": code,
        "high_f": num("/daily/temperature_2m_max/0"),
        "low_f": num("/daily/temperature_2m_min/0"),
        "rain_chance_pct": num("/daily/precipitation_probability_max/0"),
        "wind_mph": num("/current/wind_speed_10m"),
    }))
}

/// WMO weather interpretation codes, as a spoken phrase (as the API's).
fn describe(code: i64) -> &'static str {
    match code {
        0 => "clear",
        1 => "mostly clear",
        2 => "partly cloudy",
        3 => "overcast",
        45 | 48 => "foggy",
        51 | 53 | 55 | 56 | 57 => "drizzle",
        61 | 80 => "light rain",
        63 | 81 => "rain",
        65 | 82 => "heavy rain",
        66 | 67 => "freezing rain",
        71 | 73 | 75 | 77 | 85 | 86 => "snow",
        95 => "thunderstorms",
        96 | 99 => "thunderstorms with hail",
        _ => "unsettled",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_a_position_by_its_town() {
        let v = json!({"address": {"town": "Calabasas", "county": "Los Angeles County", "state": "California", "country_code": "us"}});
        assert_eq!(
            name_of(&v),
            (
                Some("Calabasas".into()),
                Some("California".into()),
                Some("US".into())
            )
        );
        assert_eq!(
            name_of(&json!({"error": "Unable to geocode"})),
            (None, None, None)
        );
    }

    #[test]
    fn picks_the_place_the_hint_names() {
        let v = json!({"results": [
            {"name": "Austin", "admin1": "Minnesota", "country_code": "US", "latitude": 43.67, "longitude": -92.97, "timezone": "America/Chicago"},
            {"name": "Austin", "admin1": "Texas", "country_code": "US", "latitude": 30.27, "longitude": -97.74, "timezone": "America/Chicago"},
        ]});
        assert_eq!(
            pick_place(&v, None).unwrap().region.as_deref(),
            Some("Minnesota")
        );
        let tx = pick_place(&v, Some("TX")).unwrap();
        assert_eq!((tx.region.as_deref(), tx.lat), (Some("Texas"), 30.27));
        assert_eq!(pick_place(&v, Some("texas")).unwrap().lat, 30.27);
        assert!(pick_place(&v, Some("France")).is_none());
        assert!(pick_place(&json!({}), None).is_none());
    }

    #[test]
    fn splits_a_hint_off_the_name() {
        assert_eq!(split_hint("Austin, TX"), ("Austin", Some("TX")));
        assert_eq!(split_hint("London"), ("London", None));
        assert_eq!(split_hint("Paris,"), ("Paris", None));
    }

    #[test]
    fn reads_the_forecast_as_the_briefing_does() {
        let v = json!({
            "timezone": "America/Chicago",
            "current": {"temperature_2m": 71.6, "weather_code": 2, "wind_speed_10m": 8.2},
            "daily": {"temperature_2m_max": [88.4], "temperature_2m_min": [65.0], "precipitation_probability_max": [40]},
        });
        let w = weather(&v, Some("Austin")).unwrap();
        assert_eq!(w["temperature_f"], 72.0);
        assert_eq!(w["conditions"], "partly cloudy");
        assert_eq!(w["high_f"], 88.0);
        assert_eq!(w["rain_chance_pct"], 40.0);
        assert_eq!(w["place"], "Austin");
        assert!(weather(&json!({}), None).is_none());
    }

    #[test]
    fn names_the_part_of_a_city_he_is_in() {
        let v = json!({"address": {"suburb": "Woodland Hills", "city": "Los Angeles", "state": "California", "country_code": "us"}});
        assert_eq!(name_of(&v).0.as_deref(), Some("Woodland Hills"));
    }

    #[test]
    fn rounds_to_about_a_hundred_metres() {
        assert_eq!(round3(34.15789), 34.158);
        assert_eq!(round3(-118.64449), -118.644);
    }
}
