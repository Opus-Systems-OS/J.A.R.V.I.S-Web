//! `/web/intel/layer/{name}`: the Intel globe's live layers, fetched here
//! from fixed hosts (the page may reach only this origin) and cached per
//! layer for as long as its source allows.
//!
//! - `satellites`: CelesTrak TLEs (space stations, the brightest, military);
//!   the page propagates them, so they move in real time.
//! - `flights`: every airborne aircraft OpenSky sees. Anonymous OpenSky is
//!   400 credits a day and a world query costs 4, hence 15 minutes.
//! - `military`: adsb.lol's military aircraft (public ADS-B, worldwide).
//! - `ships`: AIS positions sampled from AISStream for a few seconds; needs
//!   `AISSTREAM_API_KEY_FILE` (a free key), otherwise says so.
//! - `climate`: Open-Meteo's current temperature and wind on a 10° grid.
//!
//! Each item is a row: `[id, label, detail, lat, lon, alt_m, speed_ms,
//! track_deg, value]` (nulls where a source has nothing), except satellites,
//! which are `[id, name, group, line1, line2]`.

use crate::config::Profile;
use crate::error::{Error, Result};
use crate::intel::{fetch, json, now_rfc3339};
use crate::AppState;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::Extension;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use secrecy::{ExposeSecret, SecretString};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Name, cache lifetime. The index is the slot in `Intel::layers`.
pub const LAYERS: [(&str, Duration); 5] = [
    ("satellites", Duration::from_secs(6 * 3600)),
    ("flights", Duration::from_secs(15 * 60)),
    ("military", Duration::from_secs(2 * 60)),
    ("ships", Duration::from_secs(10 * 60)),
    ("climate", Duration::from_secs(30 * 60)),
];

const KNOT: f64 = 0.514_444;
const FOOT: f64 = 0.3048;
const AIS_URL: &str = "wss://stream.aisstream.io/v0/stream";
/// How long to listen to AIS, and when to stop early.
const AIS_SAMPLE: Duration = Duration::from_secs(12);
const AIS_MAX_SHIPS: usize = 5000;

pub type Slots = [tokio::sync::Mutex<Option<(Instant, Bytes)>>; LAYERS.len()];

pub async fn layer(
    State(state): State<AppState>,
    Extension(profile): Extension<Profile>,
    Path(name): Path<String>,
) -> Result<Response> {
    crate::auth::require_full(&profile)?;
    let i = LAYERS
        .iter()
        .position(|(n, _)| *n == name)
        .ok_or(Error::NotFound)?;
    // Held across the fetch: one refresh per layer at a time.
    let mut slot = state.intel.layers[i].lock().await;
    if let Some((at, body)) = slot.as_ref() {
        if at.elapsed() < LAYERS[i].1 {
            return Ok(json(body.clone()));
        }
    }
    let http = &state.http;
    let fetched = match LAYERS[i].0 {
        "satellites" => satellites(http).await,
        "flights" => fetch(
            http,
            "https://opensky-network.org/api/states/all",
            "application/json",
        )
        .await
        .and_then(|b| parse_opensky(&b)),
        "military" => fetch(http, "https://api.adsb.lol/v2/mil", "application/json")
            .await
            .and_then(|b| parse_adsb(&b)),
        "ships" => match &state.config.aisstream_key {
            Some(key) => ships(key).await,
            None => Err("needs a free AISStream key (AISSTREAM_API_KEY_FILE)".to_owned()),
        },
        _ => climate(http).await,
    };
    match fetched {
        Ok(items) => {
            let body = Bytes::from(
                serde_json::to_vec(&json!({ "generated_at": now_rfc3339(), "items": items }))
                    .map_err(|e| Error::Internal(format!("layer {name}: {e}")))?,
            );
            *slot = Some((Instant::now(), body.clone()));
            Ok(json(body))
        }
        Err(e) => {
            tracing::warn!(layer = name, error = %e, "intel layer failed");
            // A stale layer beats none; the failure is retried next request.
            if let Some((_, body)) = slot.as_ref() {
                return Ok(json(body.clone()));
            }
            Ok(json(Bytes::from(
                json!({ "generated_at": now_rfc3339(), "items": [], "error": e }).to_string(),
            )))
        }
    }
}

fn round(x: f64, places: i32) -> f64 {
    let p = 10f64.powi(places);
    (x * p).round() / p
}

/// `[id, label, detail, lat, lon, alt_m, speed_ms, track_deg, value]`.
#[allow(clippy::too_many_arguments)]
fn row(
    id: &str,
    label: &str,
    detail: &str,
    lat: f64,
    lon: f64,
    alt: Option<f64>,
    speed: Option<f64>,
    track: Option<f64>,
    value: Option<f64>,
) -> Value {
    json!([
        id,
        label.trim(),
        detail,
        round(lat, 3),
        round(lon, 3),
        alt.map(|a| a.round()),
        speed.map(|s| round(s, 1)),
        track.map(|t| t.round()),
        value.map(|v| round(v, 1)),
    ])
}

// ---- satellites --------------------------------------------------------------

const SAT_GROUPS: [(&str, &str); 3] = [
    ("visual", "bright"),
    ("stations", "station"),
    ("military", "military"),
];

async fn satellites(http: &reqwest::Client) -> std::result::Result<Vec<Value>, String> {
    let mut by_id: HashMap<String, Value> = HashMap::new();
    let mut errors = Vec::new();
    // Later groups win a satellite listed twice (military over bright).
    for (group, label) in SAT_GROUPS {
        let url = format!("https://celestrak.org/NORAD/elements/gp.php?GROUP={group}&FORMAT=tle");
        match fetch(http, &url, "text/plain").await {
            Ok(body) => {
                for (id, sat) in parse_tle(&String::from_utf8_lossy(&body), label) {
                    by_id.insert(id, sat);
                }
            }
            Err(e) => errors.push(format!("{group}: {e}")),
        }
    }
    if by_id.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(by_id.into_values().collect())
}

/// Three-line TLE text → `(norad id, [id, name, group, line1, line2])`.
pub fn parse_tle(text: &str, group: &str) -> Vec<(String, Value)> {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.is_empty())
        .collect();
    lines
        .chunks_exact(3)
        .filter(|c| c[1].starts_with("1 ") && c[2].starts_with("2 ") && c[1].len() >= 69)
        .map(|c| {
            let id = c[1][2..7].trim().to_owned();
            let v = json!([id, c[0].trim(), group, c[1], c[2]]);
            (id, v)
        })
        .collect()
}

// ---- aircraft ------------------------------------------------------------------

/// OpenSky `states`: `[icao24, callsign, country, t, t, lon, lat, baro_alt,
/// on_ground, velocity, track, …]`. Airborne aircraft with a position only.
pub fn parse_opensky(body: &[u8]) -> std::result::Result<Vec<Value>, String> {
    let v: Value = serde_json::from_slice(body).map_err(|_| "not JSON".to_owned())?;
    Ok(v["states"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| s[8].as_bool() == Some(false))
        .filter_map(|s| {
            let (lon, lat) = (s[5].as_f64()?, s[6].as_f64()?);
            Some(row(
                s[0].as_str()?,
                s[1].as_str().unwrap_or(""),
                s[2].as_str().unwrap_or(""),
                lat,
                lon,
                s[7].as_f64(),
                s[9].as_f64(),
                s[10].as_f64(),
                None,
            ))
        })
        .collect())
}

/// adsb.lol `ac`: altitude in feet (or "ground"), speed in knots.
pub fn parse_adsb(body: &[u8]) -> std::result::Result<Vec<Value>, String> {
    let v: Value = serde_json::from_slice(body).map_err(|_| "not JSON".to_owned())?;
    Ok(v["ac"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| {
            let (lat, lon) = (a["lat"].as_f64()?, a["lon"].as_f64()?);
            let detail = [a["t"].as_str(), a["r"].as_str(), a["ownOp"].as_str()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" · ");
            let callsign = a["flight"]
                .as_str()
                .map(str::trim)
                .filter(|f| !f.is_empty());
            Some(row(
                a["hex"].as_str()?,
                callsign.or(a["r"].as_str()).unwrap_or("unknown"),
                &detail,
                lat,
                lon,
                a["alt_baro"].as_f64().map(|ft| ft * FOOT),
                a["gs"].as_f64().map(|k| k * KNOT),
                a["track"].as_f64(),
                None,
            ))
        })
        .collect())
}

// ---- ships -------------------------------------------------------------------

/// A ship's latest: lat, lon, speed m/s, course, name.
type Fix = (f64, f64, Option<f64>, Option<f64>, String);

/// Listen to AISStream for `AIS_SAMPLE` and keep each ship's latest
/// position; the detail is its AIS type code when a static report arrived.
async fn ships(key: &SecretString) -> std::result::Result<Vec<Value>, String> {
    use tokio_tungstenite::tungstenite::Message;
    let (mut ws, _) = tokio::time::timeout(
        Duration::from_secs(8),
        tokio_tungstenite::connect_async(AIS_URL),
    )
    .await
    .map_err(|_| "timed out".to_owned())?
    .map_err(|_| "unreachable".to_owned())?;
    let subscribe = json!({
        "APIKey": key.expose_secret(),
        "BoundingBoxes": [[[-90, -180], [90, 180]]],
        "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
    });
    ws.send(Message::text(subscribe.to_string()))
        .await
        .map_err(|_| "subscribe failed".to_owned())?;

    let mut positions: HashMap<u64, Fix> = HashMap::new();
    let mut types: HashMap<u64, u64> = HashMap::new();
    let deadline = tokio::time::Instant::now() + AIS_SAMPLE;
    while positions.len() < AIS_MAX_SHIPS {
        let Ok(Some(Ok(msg))) = tokio::time::timeout_at(deadline, ws.next()).await else {
            break;
        };
        let v: Value = match &msg {
            Message::Text(t) => serde_json::from_str(t).unwrap_or(Value::Null),
            Message::Binary(b) => serde_json::from_slice(b).unwrap_or(Value::Null),
            _ => continue,
        };
        if let Some(e) = v["error"].as_str() {
            return Err(format!("AISStream: {e}"));
        }
        let meta = &v["MetaData"];
        let Some(mmsi) = meta["MMSI"].as_u64() else {
            continue;
        };
        match v["MessageType"].as_str() {
            Some("PositionReport") => {
                let (Some(lat), Some(lon)) =
                    (meta["latitude"].as_f64(), meta["longitude"].as_f64())
                else {
                    continue;
                };
                // AIS's "not available" is 91 / 181; 102.3 kn and 360° likewise.
                if lat.abs() > 90.0 || lon.abs() > 180.0 {
                    continue;
                }
                let p = &v["Message"]["PositionReport"];
                let sog = p["Sog"].as_f64().filter(|s| *s < 102.0).map(|s| s * KNOT);
                let cog = p["Cog"].as_f64().filter(|c| *c < 360.0);
                let name = meta["ShipName"].as_str().unwrap_or("").trim().to_owned();
                positions.insert(mmsi, (lat, lon, sog, cog, name));
            }
            Some("ShipStaticData") => {
                if let Some(t) = v["Message"]["ShipStaticData"]["Type"].as_u64() {
                    types.insert(mmsi, t);
                }
            }
            _ => {}
        }
    }
    let _ = ws.close(None).await;
    if positions.is_empty() {
        return Err("no AIS positions received (is the key valid?)".to_owned());
    }
    Ok(positions
        .into_iter()
        .map(|(mmsi, (lat, lon, sog, cog, name))| {
            let id = mmsi.to_string();
            let label = if name.is_empty() { &id } else { &name };
            let kind = types.get(&mmsi).map(|t| t.to_string()).unwrap_or_default();
            row(&id, label, &kind, lat, lon, None, sog, cog, None)
        })
        .collect())
}

// ---- climate -----------------------------------------------------------------

async fn climate(http: &reqwest::Client) -> std::result::Result<Vec<Value>, String> {
    let (mut lats, mut lons) = (Vec::new(), Vec::new());
    for lat in (-60..=70).step_by(10) {
        for lon in (-180..180).step_by(10) {
            lats.push(lat.to_string());
            lons.push(lon.to_string());
        }
    }
    let url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={}&longitude={}\
         &current=temperature_2m,wind_speed_10m,wind_direction_10m&wind_speed_unit=ms",
        lats.join(","),
        lons.join(",")
    );
    let body = fetch(http, &url, "application/json").await?;
    parse_open_meteo(&body)
}

/// One object per location (an array of them for several), current values.
pub fn parse_open_meteo(body: &[u8]) -> std::result::Result<Vec<Value>, String> {
    let v: Value = serde_json::from_slice(body).map_err(|_| "not JSON".to_owned())?;
    let places = match &v {
        Value::Array(a) => a.clone(),
        other => vec![other.clone()],
    };
    Ok(places
        .iter()
        .filter_map(|p| {
            let (lat, lon) = (p["latitude"].as_f64()?, p["longitude"].as_f64()?);
            let c = &p["current"];
            let t = c["temperature_2m"].as_f64()?;
            Some(row(
                &format!("{lat:.0},{lon:.0}"),
                &format!("{t:.0}°C"),
                "",
                lat,
                lon,
                None,
                c["wind_speed_10m"].as_f64(),
                c["wind_direction_10m"].as_f64(),
                Some(t),
            ))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tle_triplets_parse() {
        let text = "ISS (ZARYA)\n1 25544U 98067A   26293.50000000  .00016717  00000-0  10270-3 0  9005\n2 25544  51.6400 208.9163 0006317  69.9862  25.2906 15.49560066 12345\njunk\n";
        let sats = parse_tle(text, "station");
        assert_eq!(sats.len(), 1);
        assert_eq!(sats[0].0, "25544");
        assert_eq!(sats[0].1[1], "ISS (ZARYA)");
    }

    #[test]
    fn opensky_keeps_airborne_with_position() {
        let body = json!({"states": [
            ["39de4f", "TVF934S ", "France", 0, 0, -3.4018, 37.376, 10980.4, false, 213.04, 347.31],
            ["aaaaaa", "GND", "US", 0, 0, -118.0, 34.0, null, true, 0, 0],
            ["bbbbbb", "NOPOS", "US", 0, 0, null, null, 1000, false, 100, 90]
        ]})
        .to_string();
        let rows = parse_opensky(body.as_bytes()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0],
            json!(["39de4f", "TVF934S", "France", 37.376, -3.402, 10980.0, 213.0, 347.0, null])
        );
    }

    #[test]
    fn adsb_converts_feet_and_knots() {
        let body =
            json!({"ac": [{"hex": "ae04ef", "flight": "PAT079  ", "r": "86-00079", "t": "B190",
            "lat": 61.04, "lon": -157.37, "alt_baro": 10000, "gs": 100.0, "track": 265.3},
            {"hex": "x", "lat": 1.0, "lon": 2.0, "alt_baro": "ground"}]})
            .to_string();
        let rows = parse_adsb(body.as_bytes()).unwrap();
        assert_eq!(rows[0][1], "PAT079");
        assert_eq!(rows[0][2], "B190 · 86-00079");
        assert_eq!(rows[0][5], 3048.0);
        assert_eq!(rows[0][6], 51.4);
        assert_eq!(rows[1][5], Value::Null);
    }

    #[test]
    fn open_meteo_reads_one_or_many() {
        let one = json!({"latitude": 34.0, "longitude": -118.0, "current": {"temperature_2m": 21.4, "wind_speed_10m": 3.2, "wind_direction_10m": 270}});
        let rows =
            parse_open_meteo(json!([one.clone(), one.clone()]).to_string().as_bytes()).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            parse_open_meteo(one.to_string().as_bytes()).unwrap()[0][1],
            "21°C"
        );
    }
}
