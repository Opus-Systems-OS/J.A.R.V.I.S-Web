//! Public traffic cameras for the Intel globe: Caltrans (stills, and live
//! HLS on most), Maryland CHART (live HLS) and NYC DOT (stills). The `cams`
//! layer lists them; `/web/intel/cam/{id}/…` relays one camera's still or
//! stream through this origin (the page may reach no other), looked up by
//! id in the list, so the page never names a URL. Only these agencies'
//! hosts are fetched, checked again after redirects, and playlists that
//! point anywhere absolute are refused.

use crate::error::{Error, Result};
use crate::intel::{fetch, FETCH_TIMEOUT, USER_AGENT};
use crate::layers::row;
use crate::AppState;
use axum::extract::{Path, State};
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde_json::Value;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Where a camera's media is upstream.
#[derive(Debug, Clone, PartialEq)]
pub struct Cam {
    pub still: Option<String>,
    pub stream: Option<String>,
}

/// The id → media index, as of the last list.
#[derive(Default)]
pub struct Index {
    at: Option<Instant>,
    cams: HashMap<String, Cam>,
}

const INDEX_TTL: Duration = Duration::from_secs(3600);
const CALTRANS_DISTRICTS: u32 = 12;
const MD_URL: &str =
    "https://chartexp1.sha.maryland.gov/CHARTExportClientService/getCameraMapDataJSON.do";
const NYC_URL: &str = "https://webcams.nyctmc.org/api/cameras";
const MAX_STILL: usize = 2 * 1024 * 1024;
const MAX_SEGMENT: usize = 8 * 1024 * 1024;
const MAX_PLAYLIST: usize = 64 * 1024;

/// Hosts a camera's media may come from.
pub fn allowed(url: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(url) else {
        return false;
    };
    let host = u.host_str().unwrap_or_default();
    u.scheme() == "https"
        && (matches!(
            host,
            "cwwp2.dot.ca.gov" | "wzmedia.dot.ca.gov" | "webcams.nyctmc.org"
        ) || maryland_streamer(host))
}

fn maryland_streamer(host: &str) -> bool {
    host.strip_prefix("strmr")
        .and_then(|h| h.strip_suffix(".sha.maryland.gov"))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Every camera's row for the layer, and the index the relay reads.
pub async fn list(
    http: &reqwest::Client,
) -> std::result::Result<(Vec<Value>, HashMap<String, Cam>), String> {
    let mut rows = Vec::new();
    let mut index = HashMap::new();
    let mut errors = Vec::new();
    let mut add = |found: Vec<(Value, String, Cam)>| {
        for (r, id, cam) in found {
            rows.push(r);
            index.insert(id, cam);
        }
    };
    for d in 1..=CALTRANS_DISTRICTS {
        let url = format!("https://cwwp2.dot.ca.gov/data/d{d}/cctv/cctvStatusD{d:02}.json");
        match fetch(http, &url, "application/json").await {
            Ok(b) => add(parse_caltrans(&b)),
            Err(e) => errors.push(format!("caltrans d{d}: {e}")),
        }
    }
    match fetch(http, MD_URL, "application/json").await {
        Ok(b) => add(parse_maryland(&b)),
        Err(e) => errors.push(format!("maryland: {e}")),
    }
    match fetch(http, NYC_URL, "application/json").await {
        Ok(b) => add(parse_nyc(&b)),
        Err(e) => errors.push(format!("nyc: {e}")),
    }
    if rows.is_empty() {
        return Err(errors.join("; "));
    }
    if !errors.is_empty() {
        tracing::warn!(errors = %errors.join("; "), "some camera sources failed");
    }
    Ok((rows, index))
}

/// Remember the index from a layer fetch.
pub fn remember(state: &AppState, cams: HashMap<String, Cam>) {
    let mut i = state.intel.cams.lock().unwrap_or_else(|p| p.into_inner());
    *i = Index {
        at: Some(Instant::now()),
        cams,
    };
}

fn found(
    id: String,
    name: &str,
    detail: &str,
    lat: f64,
    lon: f64,
    cam: Cam,
) -> (Value, String, Cam) {
    // Bit 1: live video; bit 2: a still image.
    let media = u8::from(cam.stream.is_some()) | (u8::from(cam.still.is_some()) << 1);
    let r = row(
        &id,
        name,
        detail,
        lat,
        lon,
        None,
        None,
        None,
        Some(f64::from(media)),
    );
    (r, id, cam)
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_default().trim()
}

fn coord(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        .filter(|x| x.is_finite() && *x != 0.0)
}

/// Keep a media URL only if it is on an allowed host.
fn media(url: &str) -> Option<String> {
    let url = url.trim();
    allowed(url).then(|| url.to_owned())
}

/// A Caltrans district's `cctvStatusD{NN}.json`.
pub fn parse_caltrans(body: &[u8]) -> Vec<(Value, String, Cam)> {
    let Ok(v) = serde_json::from_slice::<Value>(body) else {
        return Vec::new();
    };
    v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| {
            let c = &d["cctv"];
            if text(c, "inService") != "true" {
                return None;
            }
            let loc = &c["location"];
            let (lat, lon) = (coord(&loc["latitude"])?, coord(&loc["longitude"])?);
            let img = &c["imageData"];
            let cam = Cam {
                still: media(
                    img["static"]["currentImageURL"]
                        .as_str()
                        .unwrap_or_default(),
                ),
                stream: media(img["streamingVideoURL"].as_str().unwrap_or_default()),
            };
            if cam.still.is_none() && cam.stream.is_none() {
                return None;
            }
            let id = format!("ca:{}-{}", text(loc, "district"), text(c, "index"));
            let place = [text(loc, "route"), text(loc, "nearbyPlace")]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(", ");
            Some(found(
                id,
                text(loc, "locationName"),
                &format!("{place} · Caltrans"),
                lat,
                lon,
                cam,
            ))
        })
        .collect()
}

/// Maryland CHART's camera map data: live video only, from its streamers.
pub fn parse_maryland(body: &[u8]) -> Vec<(Value, String, Cam)> {
    let Ok(v) = serde_json::from_slice::<Value>(body) else {
        return Vec::new();
    };
    v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            if text(c, "opStatus") != "OK" || text(c, "commMode") != "ONLINE" {
                return None;
            }
            let (id, host) = (text(c, "id"), text(c, "cctvIp"));
            if id.is_empty()
                || !id.bytes().all(|b| b.is_ascii_alphanumeric())
                || !maryland_streamer(host)
            {
                return None;
            }
            let (lat, lon) = (coord(&c["lat"])?, coord(&c["lon"])?);
            let route = format!(
                "{} {}",
                text(c, "routePrefix"),
                c["routeNumber"]
                    .as_i64()
                    .map(|n| n.to_string())
                    .unwrap_or_default()
            );
            Some(found(
                format!("md:{id}"),
                text(c, "description"),
                &format!("{} · Maryland CHART", route.trim()),
                lat,
                lon,
                Cam {
                    still: None,
                    stream: media(&format!("https://{host}/rtplive/{id}/playlist.m3u8")),
                },
            ))
        })
        .collect()
}

/// NYC DOT's webcams: stills only.
pub fn parse_nyc(body: &[u8]) -> Vec<(Value, String, Cam)> {
    let Ok(v) = serde_json::from_slice::<Value>(body) else {
        return Vec::new();
    };
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            if text(c, "isOnline") != "true" {
                return None;
            }
            let (lat, lon) = (coord(&c["latitude"])?, coord(&c["longitude"])?);
            let still = media(text(c, "imageUrl"))?;
            Some(found(
                format!("nyc:{}", text(c, "id")),
                text(c, "name"),
                &format!("{} · NYC DOT", text(c, "area")),
                lat,
                lon,
                Cam {
                    still: Some(still),
                    stream: None,
                },
            ))
        })
        .collect()
}

/// `playlist.m3u8`, `chunklist_w123.m3u8`, `media_w123_45.ts`: one file in
/// the stream's own directory.
pub fn hls_file_ok(file: &str) -> bool {
    let Some((stem, ext)) = file.rsplit_once('.') else {
        return false;
    };
    file.len() <= 96
        && matches!(ext, "m3u8" | "ts")
        && !stem.is_empty()
        && stem
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

/// A playlist may only name files relative to itself.
pub fn playlist_ok(body: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(body) else {
        return false;
    };
    text.starts_with("#EXTM3U")
        && !text.contains("://")
        && !text
            .lines()
            .any(|l| l.trim_start().starts_with('/') || l.contains("URI=\"/"))
}

async fn lookup(state: &AppState, id: &str) -> Result<Cam> {
    {
        let i = state.intel.cams.lock().unwrap_or_else(|p| p.into_inner());
        let fresh = i.at.is_some_and(|t| t.elapsed() < INDEX_TTL);
        if let Some(c) = i.cams.get(id) {
            return Ok(c.clone());
        }
        if fresh {
            return Err(Error::NotFound);
        }
    }
    let (_, cams) = list(&state.http)
        .await
        .map_err(|e| Error::Internal(format!("cameras: {e}")))?;
    let cam = cams.get(id).cloned();
    remember(state, cams);
    cam.ok_or(Error::NotFound)
}

/// Fetch `url` (an allowed host, still allowed after redirects), at most
/// `max` bytes; its body and content type.
async fn relay_fetch(state: &AppState, url: &str, max: usize) -> Result<(Vec<u8>, String)> {
    if !allowed(url) {
        return Err(Error::NotFound);
    }
    let upstream = |e: &str| Error::Internal(format!("camera: {e}"));
    let res = state
        .http
        .get(url)
        .header(header::USER_AGENT, USER_AGENT)
        .timeout(FETCH_TIMEOUT)
        .send()
        .await
        .map_err(|_| upstream("unreachable"))?;
    if !allowed(res.url().as_str()) {
        return Err(upstream("redirected off the camera's host"));
    }
    if !res.status().is_success() {
        return Err(if res.status().as_u16() == 404 {
            Error::NotFound
        } else {
            upstream(&format!("HTTP {}", res.status().as_u16()))
        });
    }
    let kind = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let mut out = Vec::new();
    let mut body = res.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|_| upstream("read failed"))?;
        if out.len() + chunk.len() > max {
            return Err(upstream("too large"));
        }
        out.extend_from_slice(&chunk);
    }
    Ok((out, kind))
}

fn media_response(body: Vec<u8>, kind: &'static str) -> Response {
    let mut res = body.into_response();
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(kind));
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// `GET /web/intel/cam/{id}/still`: the camera's latest image.
pub async fn still(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let url = lookup(&state, &id).await?.still.ok_or(Error::NotFound)?;
    let (body, kind) = relay_fetch(&state, &url, MAX_STILL).await?;
    if !kind.starts_with("image/jpeg") {
        return Err(Error::Internal("camera: not a JPEG".into()));
    }
    Ok(media_response(body, "image/jpeg"))
}

/// `GET /web/intel/cam/{id}/hls/{file}`: one file of the camera's live
/// stream, from the directory its playlist is in.
pub async fn hls(
    State(state): State<AppState>,
    Path((id, file)): Path<(String, String)>,
) -> Result<Response> {
    if !hls_file_ok(&file) {
        return Err(Error::NotFound);
    }
    let stream = lookup(&state, &id).await?.stream.ok_or(Error::NotFound)?;
    let url = reqwest::Url::parse(&stream)
        .and_then(|u| u.join(&file))
        .map_err(|_| Error::NotFound)?;
    if file.ends_with(".m3u8") {
        let (body, _) = relay_fetch(&state, url.as_str(), MAX_PLAYLIST).await?;
        if !playlist_ok(&body) {
            return Err(Error::Internal("camera: playlist points elsewhere".into()));
        }
        Ok(media_response(body, "application/vnd.apple.mpegurl"))
    } else {
        let (body, _) = relay_fetch(&state, url.as_str(), MAX_SEGMENT).await?;
        Ok(media_response(body, "video/mp2t"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caltrans_cameras_keep_their_still_and_stream() {
        let body = br#"{"data":[
          {"cctv":{"index":"1","inService":"true","location":{"district":"7","locationName":"I-110 : (196) Avenue 26 Off Ramp","nearbyPlace":"Cypress Park","longitude":"-118.2215","latitude":"34.0837","route":"I-110"},
            "imageData":{"streamingVideoURL":"https://wzmedia.dot.ca.gov/D7/CCTV-196.stream/playlist.m3u8","static":{"currentImageURL":"https://cwwp2.dot.ca.gov/data/d7/cctv/image/x/x.jpg"}}}},
          {"cctv":{"index":"2","inService":"false","location":{"district":"7","latitude":"34","longitude":"-118"},"imageData":{"static":{"currentImageURL":"https://cwwp2.dot.ca.gov/a.jpg"}}}},
          {"cctv":{"index":"3","inService":"true","location":{"district":"7","latitude":"34","longitude":"-118"},"imageData":{"streamingVideoURL":"","static":{"currentImageURL":"https://evil.example/a.jpg"}}}}
        ]}"#;
        let cams = parse_caltrans(body);
        assert_eq!(cams.len(), 1, "out of service and off-host dropped");
        let (r, id, cam) = &cams[0];
        assert_eq!(id, "ca:7-1");
        assert_eq!(r[1], "I-110 : (196) Avenue 26 Off Ramp");
        assert_eq!(r[2], "I-110, Cypress Park · Caltrans");
        assert_eq!(r[8], 3.0, "live and still");
        assert!(cam
            .stream
            .as_deref()
            .unwrap()
            .starts_with("https://wzmedia.dot.ca.gov/"));
        assert!(cam.still.is_some());
    }

    #[test]
    fn maryland_streams_only_from_its_streamers() {
        let body = br#"{"data":[
          {"id":"f1ff17ec018300940059fa36c4235c0a","cctvIp":"strmr3.sha.maryland.gov","commMode":"ONLINE","opStatus":"OK","description":"MD 295 SOUTH AT MD 197","lat":39.05668,"lon":-76.83975,"routePrefix":"MD","routeNumber":295},
          {"id":"abc","cctvIp":"evil.example","commMode":"ONLINE","opStatus":"OK","lat":39,"lon":-76},
          {"id":"../x","cctvIp":"strmr3.sha.maryland.gov","commMode":"ONLINE","opStatus":"OK","lat":39,"lon":-76},
          {"id":"def","cctvIp":"strmr5.sha.maryland.gov","commMode":"OFFLINE","opStatus":"OK","lat":39,"lon":-76}
        ]}"#;
        let cams = parse_maryland(body);
        assert_eq!(cams.len(), 1);
        let (r, id, cam) = &cams[0];
        assert_eq!(id, "md:f1ff17ec018300940059fa36c4235c0a");
        assert_eq!(r[2], "MD 295 · Maryland CHART");
        assert_eq!(r[8], 1.0, "live only");
        assert_eq!(
            cam.stream.as_deref(),
            Some("https://strmr3.sha.maryland.gov/rtplive/f1ff17ec018300940059fa36c4235c0a/playlist.m3u8")
        );
    }

    #[test]
    fn nyc_cameras_are_stills() {
        let body = br#"[{"id":"f2964d50-042c-4021-8b52-992c08c6ff6f","name":"8 Ave @ 34 St","latitude":40.7521973661027,"longitude":-73.9934562042021,"area":"Manhattan","isOnline":"true","imageUrl":"https://webcams.nyctmc.org/api/cameras/f2964d50-042c-4021-8b52-992c08c6ff6f/image"},
          {"id":"x","name":"off","latitude":40.7,"longitude":-73.9,"area":"Queens","isOnline":"false","imageUrl":"https://webcams.nyctmc.org/api/cameras/x/image"}]"#;
        let cams = parse_nyc(body);
        assert_eq!(cams.len(), 1);
        assert_eq!(cams[0].0[8], 2.0, "still only");
        assert_eq!(cams[0].0[2], "Manhattan · NYC DOT");
        assert!(cams[0].2.stream.is_none());
    }

    #[test]
    fn only_camera_hosts_are_allowed() {
        assert!(allowed(
            "https://strmr10.sha.maryland.gov/rtplive/a/playlist.m3u8"
        ));
        assert!(allowed(
            "https://wzmedia.dot.ca.gov/D7/x.stream/playlist.m3u8"
        ));
        assert!(!allowed("http://wzmedia.dot.ca.gov/D7/x"), "https only");
        assert!(!allowed("https://strmr.sha.maryland.gov/x"));
        assert!(!allowed("https://strmr3.sha.maryland.gov.evil.example/x"));
        assert!(!allowed("https://169.254.169.254/latest"));
    }

    #[test]
    fn hls_files_stay_in_the_stream_directory() {
        assert!(hls_file_ok("playlist.m3u8"));
        assert!(hls_file_ok("chunklist_w1157972939.m3u8"));
        assert!(hls_file_ok("media_w85656123_32082.ts"));
        assert!(!hls_file_ok("../playlist.m3u8"));
        assert!(!hls_file_ok("a/b.ts"));
        assert!(!hls_file_ok("x.mp4"));
        assert!(!hls_file_ok(".ts"));
        assert!(!hls_file_ok(&format!("{}.ts", "a".repeat(96))));
    }

    #[test]
    fn playlists_must_be_relative() {
        assert!(playlist_ok(
            b"#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10.0,\nmedia_w1_2.ts\n"
        ));
        assert!(!playlist_ok(b"#EXTM3U\nhttps://evil.example/a.ts\n"));
        assert!(!playlist_ok(b"#EXTM3U\n/abs/a.ts\n"));
        assert!(!playlist_ok(
            b"#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"/k\"\na.ts\n"
        ));
        assert!(!playlist_ok(b"<html>"));
    }
}
