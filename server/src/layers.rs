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
//! - `air`: Open-Meteo's current US AQI and PM2.5, on a 10° grid worldwide
//!   and a 2° one over the contiguous US.
//! - `conflict`: GDELT's machine-coded violent events (assault, fighting,
//!   mass violence) from the last two hours of its 15-minute exports, placed
//!   at city level, one per article. Machine coding is noisy; the dossier
//!   says so.
//!
//! Each item is a row: `[id, label, detail, lat, lon, alt_m, speed_ms,
//! track_deg, value]` (nulls where a source has nothing), except satellites,
//! which are `[id, name, group, line1, line2]`, and conflict, whose rows
//! carry the article's link as a tenth field.

use crate::error::{Error, Result};
use crate::intel::{fetch, json, now_rfc3339};
use crate::AppState;
use axum::extract::{Path, State};
use axum::response::Response;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use secrecy::{ExposeSecret, SecretString};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Name, cache lifetime. The index is the slot in `Intel::layers`.
pub const LAYERS: [(&str, Duration); 7] = [
    ("satellites", Duration::from_secs(6 * 3600)),
    ("flights", Duration::from_secs(15 * 60)),
    ("military", Duration::from_secs(2 * 60)),
    ("ships", Duration::from_secs(10 * 60)),
    ("climate", Duration::from_secs(30 * 60)),
    ("air", Duration::from_secs(30 * 60)),
    ("conflict", Duration::from_secs(15 * 60)),
];

const KNOT: f64 = 0.514_444;
const FOOT: f64 = 0.3048;
const AIS_URL: &str = "wss://stream.aisstream.io/v0/stream";
/// How long to listen to AIS, and when to stop early.
const AIS_SAMPLE: Duration = Duration::from_secs(12);
const AIS_MAX_SHIPS: usize = 5000;

pub type Slots = [tokio::sync::Mutex<Option<(Instant, Bytes)>>; LAYERS.len()];

pub async fn layer(State(state): State<AppState>, Path(name): Path<String>) -> Result<Response> {
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
        "air" => air(http).await,
        "conflict" => conflict(http).await,
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
    let (triplets, _) = lines.as_chunks::<3>();
    triplets
        .iter()
        .filter(|[_, l1, l2]| l1.starts_with("1 ") && l2.starts_with("2 ") && l1.len() >= 69)
        .map(|[name, l1, l2]| {
            let id = l1[2..7].trim().to_owned();
            let v = json!([id, name.trim(), group, l1, l2]);
            (id, v)
        })
        .collect()
}

// ---- air quality ---------------------------------------------------------------

async fn air(http: &reqwest::Client) -> std::result::Result<Vec<Value>, String> {
    let world = grid((-50..=70).step_by(10), (-180..180).step_by(10));
    let us = grid((26..=48).step_by(2), (-124..=-68).step_by(2));
    let mut out = Vec::new();
    let mut errors = Vec::new();
    for (lats, lons) in [world, us] {
        let url = format!(
            "https://air-quality-api.open-meteo.com/v1/air-quality?latitude={lats}&longitude={lons}&current=us_aqi,pm2_5"
        );
        match fetch(http, &url, "application/json").await {
            Ok(body) => out.extend(parse_air(&body)?),
            Err(e) => errors.push(e),
        }
    }
    if out.is_empty() && !errors.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(out)
}

/// Every pair of the two ranges, as Open-Meteo's comma lists.
fn grid(
    lats: impl Iterator<Item = i32> + Clone,
    lons: impl Iterator<Item = i32> + Clone,
) -> (String, String) {
    let pairs: Vec<(i32, i32)> = lats
        .flat_map(|a| lons.clone().map(move |o| (a, o)))
        .collect();
    let join = |f: fn(&(i32, i32)) -> i32| {
        pairs
            .iter()
            .map(|p| f(p).to_string())
            .collect::<Vec<_>>()
            .join(",")
    };
    (join(|p| p.0), join(|p| p.1))
}

/// Like `parse_open_meteo`: label `AQI 59`, detail the PM2.5 in µg/m³,
/// value the US AQI. Cells with no reading (open ocean) are left out.
pub fn parse_air(body: &[u8]) -> std::result::Result<Vec<Value>, String> {
    let v: Value = serde_json::from_slice(body).map_err(|_| "not JSON".to_owned())?;
    let places = match &v {
        Value::Array(a) => a.clone(),
        other => vec![other.clone()],
    };
    Ok(places
        .iter()
        .filter_map(|p| {
            let (lat, lon) = (p["latitude"].as_f64()?, p["longitude"].as_f64()?);
            let aqi = p["current"]["us_aqi"].as_f64()?;
            let pm = p["current"]["pm2_5"]
                .as_f64()
                .map(|x| format!("{x:.1}"))
                .unwrap_or_default();
            Some(row(
                &format!("{lat:.1},{lon:.1}"),
                &format!("AQI {aqi:.0}"),
                &pm,
                lat,
                lon,
                None,
                None,
                None,
                Some(aqi),
            ))
        })
        .collect())
}

// ---- conflict ------------------------------------------------------------------

const GDELT: &str = "https://data.gdeltproject.org/gdeltv2/";
/// Two hours of 15-minute exports.
const GDELT_SLOTS: i64 = 8;
const GDELT_MAX_CSV: u64 = 40 * 1024 * 1024;

async fn conflict(http: &reqwest::Client) -> std::result::Result<Vec<Value>, String> {
    let last = fetch(http, &format!("{GDELT}lastupdate.txt"), "text/plain").await?;
    let latest = gdelt_latest(&String::from_utf8_lossy(&last)).ok_or("no export listed")?;
    let mut events = Vec::new();
    let mut errors = Vec::new();
    // The newest export is listed a little before it is up: a 404 there is normal.
    for slot in gdelt_slots(latest, GDELT_SLOTS) {
        let url = format!("{GDELT}{slot}.export.CSV.zip");
        match fetch(http, &url, "application/zip")
            .await
            .and_then(|z| unzip_one(&z))
        {
            Ok(csv) => events.extend(parse_gdelt(&csv)),
            Err(e) => errors.push(format!("{slot}: {e}")),
        }
    }
    if events.is_empty() && errors.len() as i64 == GDELT_SLOTS {
        return Err(errors.join("; "));
    }
    Ok(dedupe_by_url(events))
}

/// `lastupdate.txt`'s export line → its `YYYYMMDDHHMMSS` slot.
pub fn gdelt_latest(text: &str) -> Option<i64> {
    let url = text.lines().find(|l| l.contains(".export.CSV.zip"))?;
    let name = url.rsplit('/').next()?;
    let stamp = name.split('.').next()?;
    (stamp.len() == 14 && stamp.bytes().all(|b| b.is_ascii_digit()))
        .then(|| stamp.parse().ok())
        .flatten()
}

/// `n` slots back from `latest` (inclusive), 15 minutes apart, as stamps.
pub fn gdelt_slots(latest: i64, n: i64) -> Vec<String> {
    use time::{Date, Month, PrimitiveDateTime, Time};
    let d = |i: u32, len: u32| ((latest / 10i64.pow(14 - i - len)) % 10i64.pow(len)) as u32;
    let Some(t) = Month::try_from(d(4, 2) as u8)
        .ok()
        .and_then(|m| Date::from_calendar_date(d(0, 4) as i32, m, d(6, 2) as u8).ok())
        .zip(Time::from_hms(d(8, 2) as u8, d(10, 2) as u8, d(12, 2) as u8).ok())
        .map(|(date, time)| PrimitiveDateTime::new(date, time))
    else {
        return Vec::new();
    };
    (0..n)
        .map(|i| {
            let s = t - time::Duration::minutes(15 * i);
            format!(
                "{:04}{:02}{:02}{:02}{:02}{:02}",
                s.year(),
                s.month() as u8,
                s.day(),
                s.hour(),
                s.minute(),
                s.second()
            )
        })
        .collect()
}

/// The first file of a zip archive (GDELT's hold one), inflated.
pub fn unzip_one(zip: &[u8]) -> std::result::Result<Vec<u8>, String> {
    use std::io::Read;
    let u16_at = |i: usize| {
        zip.get(i..i + 2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]) as usize)
    };
    if zip.get(0..4) != Some(&[0x50, 0x4b, 0x03, 0x04]) {
        return Err("not a zip".into());
    }
    let (method, name, extra) = (u16_at(8), u16_at(26), u16_at(28));
    let start = 30 + name.ok_or("short zip")? + extra.ok_or("short zip")?;
    let data = zip.get(start..).ok_or("short zip")?;
    let mut out = Vec::new();
    match method {
        Some(8) => flate2::read::DeflateDecoder::new(data)
            .take(GDELT_MAX_CSV)
            .read_to_end(&mut out)
            .map_err(|_| "bad deflate".to_owned())?,
        _ => return Err("unsupported zip".into()),
    };
    Ok(out)
}

/// CAMEO root codes kept: assault, fight, mass violence.
const VIOLENT: [&str; 3] = ["18", "19", "20"];

/// GDELT 2.0 event rows (61 tab-separated columns) → violent root events
/// placed at a city (`ActionGeo_Type` 3 or 4), as rows with the article
/// link tenth and its mention count as the value.
pub fn parse_gdelt(csv: &[u8]) -> Vec<(Value, u64)> {
    String::from_utf8_lossy(csv)
        .lines()
        .filter_map(|line| {
            let c: Vec<&str> = line.split('\t').collect();
            if c.len() < 61
                || c[25] != "1"
                || !VIOLENT.contains(&c[28])
                || !matches!(c[51], "3" | "4")
            {
                return None;
            }
            let (lat, lon) = (c[56].parse::<f64>().ok()?, c[57].parse::<f64>().ok()?);
            let url = c[60].trim();
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return None;
            }
            let place = c[52].trim();
            let mentions = c[31].parse::<u64>().unwrap_or(1);
            let mut r = row(
                c[0],
                &headline(url).unwrap_or_else(|| place.to_owned()),
                place,
                lat,
                lon,
                None,
                None,
                None,
                c[28].parse::<f64>().ok(),
            );
            r.as_array_mut()?.push(Value::String(url.to_owned()));
            Some((r, mentions))
        })
        .collect()
}

/// One event per article, the most mentioned; then the most mentioned first.
fn dedupe_by_url(events: Vec<(Value, u64)>) -> Vec<Value> {
    let mut best: HashMap<String, (Value, u64)> = HashMap::new();
    for (r, n) in events {
        let url = r[9].as_str().unwrap_or_default().to_owned();
        if best.get(&url).is_none_or(|(_, m)| n > *m) {
            best.insert(url, (r, n));
        }
    }
    let mut out: Vec<(Value, u64)> = best.into_values().collect();
    out.sort_by_key(|x| std::cmp::Reverse(x.1));
    out.into_iter().map(|(r, _)| r).collect()
}

/// A headline from an article's slug, `…/retired-soldier-shoots-youth-dead/articleshow/1350.cms`
/// → "Retired soldier shoots youth dead". `None` when no segment reads as words.
pub fn headline(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next()?;
    let path = path.split("://").nth(1)?.split_once('/')?.1;
    path.rsplit('/').find_map(|seg| {
        let seg = seg
            .trim_end_matches(".html")
            .trim_end_matches(".htm")
            .trim_end_matches(".cms")
            .trim_end_matches(".php")
            .trim_end_matches(".ece");
        let words: Vec<&str> = seg
            .split(['-', '_', '+'])
            .filter(|w| !w.is_empty())
            .filter(|w| !(w.chars().any(|c| c.is_ascii_digit()) && w.len() > 3))
            // A date in front ("10-21-…") is not part of the headline.
            .skip_while(|w| w.bytes().all(|b| b.is_ascii_digit()))
            .collect();
        if words.len() < 3 || !words.iter().all(|w| w.chars().all(char::is_alphanumeric)) {
            return None;
        }
        let text = words.join(" ");
        let mut c = text.chars();
        let first = c.next()?;
        Some(clip_words(
            &format!("{}{}", first.to_uppercase(), c.as_str()),
            120,
        ))
    })
}

fn clip_words(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_owned();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{}…", cut.rsplit_once(' ').map_or(cut.as_str(), |x| x.0))
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

    fn gdelt_row(id: &str, root: &str, geo: &str, url: &str, mentions: &str) -> String {
        let mut c = vec![""; 61];
        c[0] = id;
        c[25] = "1";
        c[28] = root;
        c[31] = mentions;
        c[51] = geo;
        c[52] = "Indore, Madhya Pradesh, India";
        c[56] = "22.7179";
        c[57] = "75.8333";
        c[60] = url;
        c.join("\t")
    }

    #[test]
    fn gdelt_keeps_violent_city_events_one_per_article() {
        let url = "https://example.com/city/indore/retired-soldier-shoots-indore-youth-dead/articleshow/135079862.cms";
        let csv = [
            gdelt_row("1", "19", "4", url, "2"),
            gdelt_row("2", "19", "4", url, "9"),
            gdelt_row("3", "04", "4", "https://example.com/a-b-c", "5"), // consult: not violent
            gdelt_row("4", "18", "1", "https://example.com/x-y-z", "5"), // country only
            gdelt_row("5", "20", "3", "javascript:alert(1)", "5"),
        ]
        .join("\n");
        let rows = dedupe_by_url(parse_gdelt(csv.as_bytes()));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0][0], "2", "the most mentioned");
        assert_eq!(rows[0][1], "Retired soldier shoots indore youth dead");
        assert_eq!(rows[0][2], "Indore, Madhya Pradesh, India");
        assert_eq!(rows[0][8], 19.0);
        assert_eq!(rows[0][9], url);
    }

    #[test]
    fn headlines_come_from_slugs() {
        assert_eq!(
            headline("https://katu.com/news/local/vancouver-attempted-murder-suspect-identified")
                .as_deref(),
            Some("Vancouver attempted murder suspect identified")
        );
        assert_eq!(headline("https://www.el-balad.com/17059512"), None);
        assert_eq!(
            headline("https://e.com/10-21-mayor-claims-seat-despite-appeal").as_deref(),
            Some("Mayor claims seat despite appeal")
        );
        assert_eq!(headline("https://e.com/"), None);
    }

    #[test]
    fn gdelt_slots_step_back_across_midnight() {
        let latest = gdelt_latest(
            "50371 25ae http://data.gdeltproject.org/gdeltv2/20261021001500.export.CSV.zip\n66221 3aeb http://data.gdeltproject.org/gdeltv2/20261021001500.mentions.CSV.zip",
        )
        .unwrap();
        assert_eq!(
            gdelt_slots(latest, 3),
            ["20261021001500", "20261021000000", "20261020234500"]
        );
        assert_eq!(gdelt_latest("nothing here"), None);
    }

    #[test]
    fn single_file_zips_inflate() {
        use std::io::Write;
        let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
        enc.write_all(b"hello\tworld\n").unwrap();
        let body = enc.finish().unwrap();
        let mut zip = vec![0x50, 0x4b, 0x03, 0x04];
        zip.extend([0u8; 4]); // version, flags
        zip.extend(8u16.to_le_bytes()); // deflate
        zip.extend([0u8; 16]); // time, date, crc, sizes
        zip.extend(1u16.to_le_bytes()); // name length
        zip.extend(0u16.to_le_bytes()); // extra length
        zip.push(b'a');
        zip.extend(body);
        assert_eq!(unzip_one(&zip).unwrap(), b"hello\tworld\n");
        assert!(unzip_one(b"<html>404</html>").is_err());
    }

    #[test]
    fn air_cells_skip_missing_readings() {
        let body = br#"[{"latitude":34.2,"longitude":-118.6,"current":{"us_aqi":59,"pm2_5":9.9}},{"latitude":0,"longitude":-150,"current":{"us_aqi":null}}]"#;
        let rows = parse_air(body).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0][1], "AQI 59");
        assert_eq!(rows[0][2], "9.9");
        assert_eq!(rows[0][8], 59.0);
    }

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
