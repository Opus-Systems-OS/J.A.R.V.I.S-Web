//! `/web/intel/layer/{name}`: the Intel globe's live layers, fetched here
//! from fixed hosts (the page may reach only this origin) and cached per
//! layer for as long as its source allows.
//!
//! - `satellites`: CelesTrak TLEs (space stations, the brightest, military);
//!   the page propagates them, so they move in real time.
//! - `flights`: every airborne aircraft OpenSky sees. Anonymous OpenSky is
//!   400 credits a day and a world query costs 4, hence 15 minutes.
//! - `military`: adsb.lol's military aircraft (public ADS-B, worldwide).
//! - `ships`: every ship heard on one long-lived AISStream connection in
//!   the last half hour; needs `AISSTREAM_API_KEY_FILE` (a free key),
//!   otherwise says so.
//! - `climate`: Open-Meteo's current temperature and wind on a 10° grid.
//! - `bases`: active military installations and spaceports on Wikidata,
//!   sorted into air, navy, army and space by their class, operator and name.
//!
//! Each item is a row: `[id, label, detail, lat, lon, alt_m, speed_ms,
//! track_deg, value]` (nulls where a source has nothing), except satellites,
//! which are `[id, name, group, line1, line2]`.

use crate::config::Profile;
use crate::error::{Error, Result};
use crate::intel::{fetch, fetch_within, json, now_rfc3339};
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
pub const LAYERS: [(&str, Duration); 6] = [
    ("satellites", Duration::from_secs(6 * 3600)),
    ("flights", Duration::from_secs(15 * 60)),
    ("military", Duration::from_secs(2 * 60)),
    ("ships", Duration::from_secs(30)),
    ("climate", Duration::from_secs(30 * 60)),
    ("bases", Duration::from_secs(24 * 3600)),
];

const KNOT: f64 = 0.514_444;
const FOOT: f64 = 0.3048;
const AIS_URL: &str = "wss://stream.aisstream.io/v0/stream";
/// Ships not heard from in this long are dropped; at most this many kept.
const AIS_STALE: Duration = Duration::from_secs(30 * 60);
const AIS_MAX_SHIPS: usize = 50_000;
const AIS_PRUNE_EVERY: Duration = Duration::from_secs(60);
const AIS_IDLE: Duration = Duration::from_secs(60);
const AIS_BACKOFF_MIN: Duration = Duration::from_secs(5);
const AIS_BACKOFF_MAX: Duration = Duration::from_secs(5 * 60);

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
            Some(_) => state.intel.fleet.lock().expect("fleet").rows(),
            None => Err("needs a free AISStream key (AISSTREAM_API_KEY_FILE)".to_owned()),
        },
        "bases" => bases(http).await,
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

/// Every ship AISStream has reported lately, kept by [`spawn_ais`]'s one
/// long-lived connection: MMSI → latest fix, and MMSI → AIS type code (static
/// reports come every few minutes, so these fill in over time).
#[derive(Default)]
pub struct Fleet {
    positions: HashMap<u64, (Fix, Instant)>,
    types: HashMap<u64, (u64, Instant)>,
    /// Why the stream last failed; shown only while there are no ships.
    error: Option<String>,
}

impl Fleet {
    /// Take one AISStream message; `Err` is the stream's own `{"error": …}`.
    fn apply(&mut self, v: &Value, now: Instant) -> std::result::Result<(), String> {
        if let Some(e) = v["error"].as_str() {
            return Err(format!("AISStream: {e}"));
        }
        let meta = &v["MetaData"];
        let Some(mmsi) = meta["MMSI"].as_u64() else {
            return Ok(());
        };
        match v["MessageType"].as_str() {
            Some("PositionReport") => {
                let (Some(lat), Some(lon)) =
                    (meta["latitude"].as_f64(), meta["longitude"].as_f64())
                else {
                    return Ok(());
                };
                // AIS's "not available" is 91 / 181; 102.3 kn and 360° likewise.
                if lat.abs() > 90.0 || lon.abs() > 180.0 {
                    return Ok(());
                }
                let p = &v["Message"]["PositionReport"];
                let sog = p["Sog"].as_f64().filter(|s| *s < 102.0).map(|s| s * KNOT);
                let cog = p["Cog"].as_f64().filter(|c| *c < 360.0);
                let name = meta["ShipName"].as_str().unwrap_or("").trim().to_owned();
                // shortcut: at the cap new ships wait for the next prune; raise AIS_MAX_SHIPS if it is hit.
                if self.positions.len() < AIS_MAX_SHIPS || self.positions.contains_key(&mmsi) {
                    self.positions
                        .insert(mmsi, ((lat, lon, sog, cog, name), now));
                }
            }
            Some("ShipStaticData") => {
                if let Some(t) = v["Message"]["ShipStaticData"]["Type"].as_u64() {
                    if self.types.len() < AIS_MAX_SHIPS || self.types.contains_key(&mmsi) {
                        self.types.insert(mmsi, (t, now));
                    }
                }
            }
            _ => {}
        }
        self.error = None;
        Ok(())
    }

    /// Forget ships not heard from in `AIS_STALE`.
    fn prune(&mut self, now: Instant) {
        self.positions
            .retain(|_, (_, at)| now.duration_since(*at) < AIS_STALE);
        self.types
            .retain(|_, (_, at)| now.duration_since(*at) < AIS_STALE);
    }

    /// The layer's rows; the detail is the AIS type code once one arrived.
    fn rows(&self) -> std::result::Result<Vec<Value>, String> {
        if self.positions.is_empty() {
            return Err(self
                .error
                .clone()
                .unwrap_or_else(|| "no AIS positions received yet".to_owned()));
        }
        Ok(self
            .positions
            .iter()
            .map(|(mmsi, ((lat, lon, sog, cog, name), _))| {
                let id = mmsi.to_string();
                let label = if name.is_empty() { &id } else { name };
                let kind = self
                    .types
                    .get(mmsi)
                    .map(|(t, _)| t.to_string())
                    .unwrap_or_default();
                row(&id, label, &kind, *lat, *lon, None, *sog, *cog, None)
            })
            .collect())
    }
}

/// With an AISStream key, hold one connection open for the server's life,
/// reconnecting with backoff, and keep `Intel::fleet` current.
pub fn spawn_ais(state: &AppState) {
    let Some(key) = state.config.aisstream_key.clone() else {
        return;
    };
    let intel = state.intel.clone();
    tokio::spawn(async move {
        let mut backoff = AIS_BACKOFF_MIN;
        loop {
            let started = Instant::now();
            let e = ais_session(&key, &intel.fleet).await;
            tracing::warn!(error = %e, "AISStream disconnected");
            intel.fleet.lock().expect("fleet").error = Some(e);
            // A connection that held a while earns a quick reconnect.
            if started.elapsed() > AIS_BACKOFF_MAX {
                backoff = AIS_BACKOFF_MIN;
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(AIS_BACKOFF_MAX);
        }
    });
}

/// One connection, until it fails; returns why.
async fn ais_session(key: &SecretString, fleet: &std::sync::Mutex<Fleet>) -> String {
    use tokio_tungstenite::tungstenite::Message;
    let (mut ws, _) = match tokio::time::timeout(
        Duration::from_secs(8),
        tokio_tungstenite::connect_async(AIS_URL),
    )
    .await
    {
        Err(_) => return "timed out".to_owned(),
        Ok(Err(_)) => return "unreachable".to_owned(),
        Ok(Ok(ws)) => ws,
    };
    let subscribe = json!({
        "APIKey": key.expose_secret(),
        "BoundingBoxes": [[[-90, -180], [90, 180]]],
        "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
    });
    if ws.send(Message::text(subscribe.to_string())).await.is_err() {
        return "subscribe failed".to_owned();
    }
    let mut pruned = Instant::now();
    loop {
        // The whole world never goes quiet this long; a silent socket is dead.
        let msg = match tokio::time::timeout(AIS_IDLE, ws.next()).await {
            Err(_) => return "no messages for a minute".to_owned(),
            Ok(None) => return "closed".to_owned(),
            Ok(Some(Err(e))) => return format!("read: {e}"),
            Ok(Some(Ok(msg))) => msg,
        };
        let v: Value = match &msg {
            Message::Text(t) => serde_json::from_str(t).unwrap_or(Value::Null),
            Message::Binary(b) => serde_json::from_slice(b).unwrap_or(Value::Null),
            _ => continue,
        };
        let now = Instant::now();
        let mut fleet = fleet.lock().expect("fleet");
        if let Err(e) = fleet.apply(&v, now) {
            return e;
        }
        if now.duration_since(pruned) > AIS_PRUNE_EVERY {
            fleet.prune(now);
            pruned = now;
        }
    }
}

// ---- military bases -----------------------------------------------------------

/// Air bases, naval and submarine bases, military bases, space force bases
/// and spaceports, still in use, with a position and an English name.
const BASES_QUERY: &str = r#"SELECT ?item ?itemLabel (SAMPLE(?coord) AS ?c)
  (GROUP_CONCAT(DISTINCT ?classLabel; separator=", ") AS ?kinds) (SAMPLE(?countryLabel) AS ?country)
  (GROUP_CONCAT(DISTINCT ?opLabel; separator=", ") AS ?ops) WHERE {
  VALUES ?class { wd:Q695850 wd:Q1324633 wd:Q331367 wd:Q245016 wd:Q18691599 wd:Q131520524 wd:Q194188 }
  ?item wdt:P31 ?class ; wdt:P625 ?coord ; rdfs:label ?itemLabel . FILTER(LANG(?itemLabel) = "en")
  FILTER NOT EXISTS { ?item wdt:P576|wdt:P3999 [] }
  ?class rdfs:label ?classLabel . FILTER(LANG(?classLabel) = "en")
  OPTIONAL { ?item wdt:P17 ?cty . ?cty rdfs:label ?countryLabel . FILTER(LANG(?countryLabel) = "en") }
  OPTIONAL { ?item wdt:P137|wdt:P241 ?op . ?op rdfs:label ?opLabel . FILTER(LANG(?opLabel) = "en") }
} GROUP BY ?item ?itemLabel"#;

async fn bases(http: &reqwest::Client) -> std::result::Result<Vec<Value>, String> {
    let url = reqwest::Url::parse_with_params(
        "https://query.wikidata.org/sparql",
        &[("query", BASES_QUERY)],
    )
    .map_err(|e| format!("url: {e}"))?;
    let body = fetch_within(
        http,
        url.as_str(),
        "application/sparql-results+json",
        Duration::from_secs(45),
    )
    .await?;
    parse_bases(&body)
}

/// air | navy | army | space, from the site's classes, operators and name.
pub fn branch(name: &str, kinds: &str, ops: &str) -> &'static str {
    // "Aerospace Forces" is an air force, not a space one.
    let t = format!("{name} | {kinds} | {ops}")
        .to_lowercase()
        .replace("aerospace", "aero");
    let has = |words: &[&str]| words.iter().any(|w| t.contains(w));
    // Commonwealth shore establishments are named like ships.
    let navy_name = ["INS ", "HMS ", "HMAS ", "HMNZS ", "HMCS ", "HMNB "]
        .iter()
        .any(|p| name.starts_with(p));
    if has(&[
        "space force",
        "spaceport",
        "cosmodrome",
        "space center",
        "space centre",
        "launch site",
        "space command",
    ]) {
        "space"
    } else if navy_name
        || has(&[
            "naval",
            "navy",
            "submarine",
            "marine corps",
            "marines",
            "coast guard",
            "fleet",
        ])
    {
        "navy"
    } else if has(&[
        "airbase",
        "air base",
        "air force",
        "air station",
        "raf ",
        "air national guard",
        "aero",
    ]) {
        "air"
    } else {
        "army"
    }
}

/// SPARQL JSON → `[qid, name, "branch|kinds|country|operators", lat, lon, …]`.
pub fn parse_bases(body: &[u8]) -> std::result::Result<Vec<Value>, String> {
    let v: Value = serde_json::from_slice(body).map_err(|_| "not JSON".to_owned())?;
    let s = |b: &Value, k: &str| b[k]["value"].as_str().unwrap_or("").to_owned();
    Ok(v["results"]["bindings"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| {
            // WKT "Point(lon lat)".
            let c = s(b, "c");
            let mut ll = c.strip_prefix("Point(")?.strip_suffix(')')?.split(' ');
            let (lon, lat) = (ll.next()?.parse().ok()?, ll.next()?.parse().ok()?);
            let id = s(b, "item").rsplit('/').next()?.to_owned();
            let (name, kinds, ops) = (s(b, "itemLabel"), s(b, "kinds"), s(b, "ops"));
            let detail = format!(
                "{}|{kinds}|{}|{ops}",
                branch(&name, &kinds, &ops),
                s(b, "country")
            );
            Some(row(&id, &name, &detail, lat, lon, None, None, None, None))
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

    fn position(mmsi: u64, name: &str, lat: f64, sog: f64, cog: f64) -> Value {
        json!({"MessageType": "PositionReport",
            "MetaData": {"MMSI": mmsi, "ShipName": name, "latitude": lat, "longitude": -118.25},
            "Message": {"PositionReport": {"Sog": sog, "Cog": cog}}})
    }

    #[test]
    fn fleet_rows_keep_latest_fix_and_type() {
        let (mut fleet, now) = (Fleet::default(), Instant::now());
        assert_eq!(fleet.rows().unwrap_err(), "no AIS positions received yet");
        fleet
            .apply(&position(1, "EVER GIVEN  ", 33.0, 10.0, 90.0), now)
            .unwrap();
        fleet
            .apply(&position(1, "EVER GIVEN", 33.7, 102.3, 360.0), now)
            .unwrap();
        fleet.apply(&position(2, "", 91.0, 1.0, 1.0), now).unwrap();
        fleet.apply(&position(3, "", 10.0, 0.0, 0.0), now).unwrap();
        let ship_type = json!({"MessageType": "ShipStaticData", "MetaData": {"MMSI": 1},
            "Message": {"ShipStaticData": {"Type": 70}}});
        fleet.apply(&ship_type, now).unwrap();
        let mut rows = fleet.rows().unwrap();
        rows.sort_by_key(|r| r[0].as_str().unwrap().to_owned());
        assert_eq!(
            rows,
            vec![
                json!([
                    "1",
                    "EVER GIVEN",
                    "70",
                    33.7,
                    -118.25,
                    null,
                    null,
                    null,
                    null
                ]),
                json!(["3", "3", "", 10.0, -118.25, null, 0.0, 0.0, null]),
            ]
        );
        assert_eq!(
            fleet.apply(&json!({"error": "Api Key Is Not Valid"}), now),
            Err("AISStream: Api Key Is Not Valid".to_owned())
        );
    }

    #[test]
    fn fleet_prunes_stale_ships() {
        let (mut fleet, t0) = (Fleet::default(), Instant::now());
        fleet.apply(&position(1, "OLD", 1.0, 5.0, 5.0), t0).unwrap();
        let t1 = t0 + AIS_STALE - Duration::from_secs(60);
        fleet.apply(&position(2, "NEW", 2.0, 5.0, 5.0), t1).unwrap();
        fleet.prune(t0 + AIS_STALE);
        let rows = fleet.rows().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0][1], "NEW");
    }

    #[test]
    fn bases_sort_into_branches() {
        assert_eq!(
            branch(
                "Vandenberg Space Force Base",
                "airbase, spaceport",
                "United States Space Force"
            ),
            "space"
        );
        assert_eq!(
            branch("Kubinka", "airbase", "Russian Aerospace Forces"),
            "air"
        );
        assert_eq!(
            branch("Naval Station Norfolk", "naval base, submarine base", ""),
            "navy"
        );
        assert_eq!(
            branch(
                "Marine Corps Air Station Miramar",
                "airbase",
                "United States Marine Corps"
            ),
            "navy"
        );
        assert_eq!(
            branch("Ramstein Air Base", "airbase", "United States Air Force"),
            "air"
        );
        assert_eq!(branch("Fort Bragg", "military base", ""), "army");
        assert_eq!(branch("INS Angre", "military base", ""), "navy");
        assert_eq!(branch("Fort Collins Barracks", "military base", ""), "army");
    }

    #[test]
    fn bases_parse_wkt_points() {
        let body = json!({"results": {"bindings": [
            {"item": {"value": "http://www.wikidata.org/entity/Q509549"}, "itemLabel": {"value": "Fort George G. Meade"},
             "c": {"value": "Point(-76.7431 39.1069)"}, "kinds": {"value": "military base"},
             "country": {"value": "United States"}, "ops": {"value": "United States Army"}},
            {"item": {"value": "http://www.wikidata.org/entity/Q1"}, "itemLabel": {"value": "No point"}, "c": {"value": "junk"}}
        ]}}).to_string();
        let rows = parse_bases(body.as_bytes()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0][0], "Q509549");
        assert_eq!(
            rows[0][2],
            "army|military base|United States|United States Army"
        );
        assert_eq!(rows[0][3], 39.107);
        assert_eq!(rows[0][4], -76.743);
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
