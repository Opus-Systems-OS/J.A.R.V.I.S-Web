//! `/web/intel/*`: the Intel tab's open-source feeds. The page may talk to
//! nothing but this origin, so the news wires and hazard feeds are fetched
//! here, from a fixed list, and handed over as one normalized JSON list.
//!
//! - `GET /web/intel/feed`: every source at once, cached for five minutes
//!   (one fetch at a time; a failing source is reported, never fatal).
//! - `GET /web/intel/search?q=`: news coverage of a query plus matching
//!   Wikipedia entries (public figures, places, organizations), cached ten
//!   minutes per query.
//!
//! Every URL is a constant (a search only fills in the query string of a
//! fixed host), every link handed to the page is http(s), and feed text is
//! stripped of markup here; the page still renders it with `textContent`.
//! The owner's alone, like Systems.

use crate::config::Profile;
use crate::error::{Error, Result};
use crate::AppState;
use axum::extract::{Query, State};
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::Extension;
use bytes::Bytes;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use time::format_description::well_known::{Rfc2822, Rfc3339};
use time::OffsetDateTime;

const FEED_TTL: Duration = Duration::from_secs(5 * 60);
const SEARCH_TTL: Duration = Duration::from_secs(10 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_BODY: usize = 6 * 1024 * 1024;
const MAX_SUMMARY: usize = 420;
const PER_FEED: usize = 40;
const MAX_QUERY: usize = 80;
const MAX_SEARCHES_CACHED: usize = 64;
const USER_AGENT: &str = "jarvis-web/0.1 (+https://jarvis.opustower.dev)";

#[derive(Clone, Copy, PartialEq, Debug)]
enum Format {
    Rss,
    Usgs,
    Eonet,
    CalFire,
    Nws,
    Inciweb,
}

struct Source {
    name: &'static str,
    url: &'static str,
    format: Format,
}

const SOURCES: &[Source] = &[
    Source { name: "Google News · Top", url: "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en", format: Format::Rss },
    Source { name: "Google News · U.S.", url: "https://news.google.com/rss/headlines/section/topic/NATION?hl=en-US&gl=US&ceid=US:en", format: Format::Rss },
    Source { name: "Google News · World", url: "https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en", format: Format::Rss },
    Source { name: "Google News · Incidents", url: "https://news.google.com/rss/search?q=wildfire+OR+shooting+OR+explosion+OR+evacuation+OR+police+OR+crash+when:1d&hl=en-US&gl=US&ceid=US:en", format: Format::Rss },
    Source { name: "NPR", url: "https://feeds.npr.org/1001/rss.xml", format: Format::Rss },
    Source { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", format: Format::Rss },
    Source { name: "BBC US & Canada", url: "https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml", format: Format::Rss },
    Source { name: "CBS News", url: "https://www.cbsnews.com/latest/rss/main", format: Format::Rss },
    Source { name: "ABC News", url: "https://abcnews.com/abcnews/usheadlines", format: Format::Rss },
    Source { name: "Guardian US", url: "https://www.theguardian.com/us-news/rss", format: Format::Rss },
    Source { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml", format: Format::Rss },
    Source { name: "USGS quakes", url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson", format: Format::Usgs },
    Source { name: "NASA EONET", url: "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30&limit=200", format: Format::Eonet },
    Source { name: "CAL FIRE", url: "https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=false", format: Format::CalFire },
    Source { name: "InciWeb", url: "https://inciweb.wildfire.gov/incidents/rss.xml", format: Format::Inciweb },
    Source { name: "NWS alerts", url: "https://api.weather.gov/alerts/active?status=actual&severity=Severe,Extreme", format: Format::Nws },
];

/// One event or story. Hazards arrive placed; news is placed by the page
/// (its gazetteer reads `title` and `summary`), NWS alerts by `region`.
#[derive(Serialize, Clone, Debug, Default)]
pub struct Item {
    pub id: String,
    /// news | quake | fire | storm | volcano | alert
    pub kind: &'static str,
    pub title: String,
    pub summary: String,
    pub source: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lat: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lon: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub place: Option<String>,
    /// A US state's postal code, when that is all that is known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    /// 0–1, hazards only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<f64>,
    /// Which feed it came from.
    pub feed: &'static str,
}

#[derive(Serialize)]
struct SourceStatus {
    name: &'static str,
    ok: bool,
    count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct Feed {
    generated_at: String,
    items: Vec<Item>,
    sources: Vec<SourceStatus>,
}

#[derive(Serialize, Debug)]
pub struct Entry {
    pub title: String,
    pub description: String,
    pub extract: String,
    pub url: String,
}

#[derive(Serialize)]
struct SearchOut {
    query: String,
    articles: Vec<Item>,
    entries: Vec<Entry>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    errors: Vec<String>,
}

/// The feed and search caches (memory only).
#[derive(Default)]
pub struct Intel {
    feed: tokio::sync::Mutex<Option<(Instant, Bytes)>>,
    searches: Mutex<HashMap<String, (Instant, Bytes)>>,
    pub(crate) layers: crate::layers::Slots,
}

pub(crate) fn json(body: Bytes) -> Response {
    let mut res = body.into_response();
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

pub(crate) fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_default()
}

pub async fn feed(
    State(state): State<AppState>,
    Extension(profile): Extension<Profile>,
) -> Result<Response> {
    crate::auth::require_full(&profile)?;
    // Held across the fetch: one refresh at a time, everyone else waits for it.
    let mut cached = state.intel.feed.lock().await;
    if let Some((at, body)) = cached.as_ref() {
        if at.elapsed() < FEED_TTL {
            return Ok(json(body.clone()));
        }
    }
    let http = &state.http;
    let results = futures_util::future::join_all(SOURCES.iter().map(|s| async move {
        let r = fetch(http, s.url, accept(s.format))
            .await
            .and_then(|b| parse(s, &b));
        (s, r)
    }))
    .await;

    let mut items = Vec::new();
    let mut sources = Vec::new();
    for (s, r) in results {
        match r {
            Ok(list) => {
                sources.push(SourceStatus {
                    name: s.name,
                    ok: true,
                    count: list.len(),
                    error: None,
                });
                items.extend(list);
            }
            Err(e) => {
                tracing::warn!(source = s.name, error = %e, "intel source failed");
                sources.push(SourceStatus {
                    name: s.name,
                    ok: false,
                    count: 0,
                    error: Some(e),
                });
            }
        }
    }
    let items = dedupe(items);
    let body = Bytes::from(
        serde_json::to_vec(&Feed {
            generated_at: now_rfc3339(),
            items,
            sources,
        })
        .map_err(|e| Error::Internal(format!("intel feed: {e}")))?,
    );
    *cached = Some((Instant::now(), body.clone()));
    Ok(json(body))
}

#[derive(Deserialize)]
pub struct SearchParams {
    #[serde(default)]
    q: String,
}

/// A query fit to send on: trimmed, 1–80 characters, no control characters.
pub fn clean_query(q: &str) -> Option<String> {
    let q = q.split_whitespace().collect::<Vec<_>>().join(" ");
    let n = q.chars().count();
    if n == 0 || n > MAX_QUERY || q.chars().any(char::is_control) {
        return None;
    }
    Some(q)
}

pub async fn search(
    State(state): State<AppState>,
    Extension(profile): Extension<Profile>,
    Query(params): Query<SearchParams>,
) -> Result<Response> {
    crate::auth::require_full(&profile)?;
    let q = clean_query(&params.q)
        .ok_or_else(|| Error::InvalidRequest(format!("q must be 1–{MAX_QUERY} characters")))?;
    let key = q.to_lowercase();
    {
        let cache = state.intel.searches.lock().expect("search cache");
        if let Some((at, body)) = cache.get(&key) {
            if at.elapsed() < SEARCH_TTL {
                return Ok(json(body.clone()));
            }
        }
    }

    let news_url = reqwest::Url::parse_with_params(
        "https://news.google.com/rss/search",
        &[
            ("q", q.as_str()),
            ("hl", "en-US"),
            ("gl", "US"),
            ("ceid", "US:en"),
        ],
    )
    .map_err(|e| Error::Internal(format!("search url: {e}")))?;
    let wiki_url = reqwest::Url::parse_with_params(
        "https://en.wikipedia.org/w/api.php",
        &[
            ("action", "query"),
            ("generator", "search"),
            ("gsrsearch", q.as_str()),
            ("gsrlimit", "10"),
            ("prop", "description|extracts"),
            ("exintro", "1"),
            ("explaintext", "1"),
            ("exsentences", "2"),
            ("exlimit", "10"),
            ("format", "json"),
            ("formatversion", "2"),
        ],
    )
    .map_err(|e| Error::Internal(format!("search url: {e}")))?;

    const NEWS: Source = Source {
        name: "Google News · Search",
        url: "",
        format: Format::Rss,
    };
    let (news, wiki) = tokio::join!(
        fetch(&state.http, news_url.as_str(), accept(Format::Rss)),
        fetch(&state.http, wiki_url.as_str(), "application/json"),
    );
    let mut errors = Vec::new();
    let articles = match news.and_then(|b| parse(&NEWS, &b)) {
        Ok(mut a) => {
            a.truncate(30);
            a
        }
        Err(e) => {
            errors.push(format!("news: {e}"));
            Vec::new()
        }
    };
    let entries = match wiki.and_then(|b| parse_wikipedia(&b)) {
        Ok(e) => e,
        Err(e) => {
            errors.push(format!("wikipedia: {e}"));
            Vec::new()
        }
    };
    let body = Bytes::from(
        serde_json::to_vec(&SearchOut {
            query: q,
            articles,
            entries,
            errors,
        })
        .map_err(|e| Error::Internal(format!("intel search: {e}")))?,
    );
    let mut cache = state.intel.searches.lock().expect("search cache");
    cache.retain(|_, (at, _)| at.elapsed() < SEARCH_TTL);
    if cache.len() < MAX_SEARCHES_CACHED {
        cache.insert(key, (Instant::now(), body.clone()));
    }
    Ok(json(body))
}

fn accept(format: Format) -> &'static str {
    match format {
        Format::Rss | Format::Inciweb => "application/rss+xml, application/xml, text/xml",
        Format::Nws => "application/geo+json",
        _ => "application/json",
    }
}

pub(crate) async fn fetch(
    http: &reqwest::Client,
    url: &str,
    accept: &str,
) -> std::result::Result<Vec<u8>, String> {
    fetch_within(http, url, accept, FETCH_TIMEOUT).await
}

/// `fetch` for a slow source (a Wikidata query takes several seconds).
pub(crate) async fn fetch_within(
    http: &reqwest::Client,
    url: &str,
    accept: &str,
    timeout: Duration,
) -> std::result::Result<Vec<u8>, String> {
    let res = http
        .get(url)
        .header(header::USER_AGENT, USER_AGENT)
        .header(header::ACCEPT, accept)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "timed out".to_owned()
            } else {
                "unreachable".to_owned()
            }
        })?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    let mut out = Vec::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "read failed".to_owned())?;
        if out.len() + chunk.len() > MAX_BODY {
            return Err("too large".to_owned());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

fn parse(source: &Source, body: &[u8]) -> std::result::Result<Vec<Item>, String> {
    let text = std::str::from_utf8(body).map_err(|_| "not UTF-8".to_owned())?;
    match source.format {
        Format::Rss => parse_rss(source.name, text),
        Format::Inciweb => parse_inciweb(text),
        Format::Usgs => parse_usgs(text),
        Format::Eonet => parse_eonet(text),
        Format::CalFire => parse_calfire(text),
        Format::Nws => parse_nws(text),
    }
}

// ---- text helpers ------------------------------------------------------------

/// Plain text from a feed's HTML fragment: tags dropped, common entities
/// decoded, whitespace collapsed, cut to `MAX_SUMMARY` characters.
pub fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => {
                in_tag = true;
                out.push(' ');
            }
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let decoded = decode_entities(&out);
    clip(
        &decoded.split_whitespace().collect::<Vec<_>>().join(" "),
        MAX_SUMMARY,
    )
}

fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let end = tail.find(';').filter(|&e| e <= 10);
        let decoded = end.and_then(|e| {
            let name = &tail[1..e];
            let c = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" | "#39" => Some('\''),
                "nbsp" => Some(' '),
                "mdash" => Some('—'),
                "ndash" => Some('–'),
                "hellip" => Some('…'),
                "rsquo" => Some('’'),
                "lsquo" => Some('‘'),
                "rdquo" => Some('”'),
                "ldquo" => Some('“'),
                n if n.starts_with("#x") => u32::from_str_radix(&n[2..], 16)
                    .ok()
                    .and_then(char::from_u32),
                n if n.starts_with('#') => n[1..].parse().ok().and_then(char::from_u32),
                _ => None,
            };
            c.map(|c| (c, e))
        });
        match decoded {
            Some((c, e)) => {
                out.push(c);
                rest = &tail[e + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_owned();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// Only http(s) links reach the page.
fn safe_url(u: &str) -> String {
    let u = u.trim();
    if u.starts_with("https://") || u.starts_with("http://") {
        u.to_owned()
    } else {
        String::new()
    }
}

fn rfc3339_from_rfc2822(s: &str) -> Option<String> {
    let s = s.trim();
    OffsetDateTime::parse(s, &Rfc2822)
        .or_else(|_| OffsetDateTime::parse(s, &Rfc3339))
        .ok()
        .and_then(|t| t.to_offset(time::UtcOffset::UTC).format(&Rfc3339).ok())
}

fn rfc3339_from_millis(ms: i64) -> Option<String> {
    OffsetDateTime::from_unix_timestamp_nanos(ms as i128 * 1_000_000)
        .ok()
        .and_then(|t| t.format(&Rfc3339).ok())
}

fn short_hash(s: &str) -> String {
    use sha2::{Digest, Sha256};
    crate::hex(&Sha256::digest(s.as_bytes())[..6])
}

fn norm_title(t: &str) -> String {
    t.chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .to_lowercase()
        .split_whitespace()
        .take(10)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Same story from several wires: keep the first. Newest first overall.
fn dedupe(items: Vec<Item>) -> Vec<Item> {
    let mut seen = HashSet::new();
    let mut out: Vec<Item> = items
        .into_iter()
        .filter(|i| i.kind != "news" || seen.insert(norm_title(&i.title)))
        .map(|mut i| {
            // Feeds stamp their own offsets (Guam's alerts are +10:00); in
            // UTC the strings sort as times.
            i.published = i.published.as_deref().and_then(rfc3339_from_rfc2822);
            i
        })
        .collect();
    out.sort_by(|a, b| b.published.cmp(&a.published));
    out
}

// ---- RSS / Atom ----------------------------------------------------------------

fn child_text<'a>(node: roxmltree::Node<'a, 'a>, name: &str) -> Option<&'a str> {
    node.children()
        .find(|c| c.is_element() && c.tag_name().name() == name)
        .and_then(|c| c.text())
}

pub fn parse_rss(feed: &'static str, xml: &str) -> std::result::Result<Vec<Item>, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|_| "not XML".to_owned())?;
    let google = feed.starts_with("Google News");
    let mut out = Vec::new();
    for node in doc.descendants().filter(|n| n.is_element()) {
        let tag = node.tag_name().name();
        let (title, link, summary, published) = match tag {
            "item" => (
                child_text(node, "title").unwrap_or(""),
                child_text(node, "link").unwrap_or("").to_owned(),
                child_text(node, "description").unwrap_or(""),
                child_text(node, "pubDate").or_else(|| child_text(node, "date")),
            ),
            "entry" => (
                child_text(node, "title").unwrap_or(""),
                node.children()
                    .find(|c| c.is_element() && c.tag_name().name() == "link")
                    .and_then(|l| l.attribute("href"))
                    .unwrap_or("")
                    .to_owned(),
                child_text(node, "summary")
                    .or_else(|| child_text(node, "content"))
                    .unwrap_or(""),
                child_text(node, "updated").or_else(|| child_text(node, "published")),
            ),
            _ => continue,
        };
        let mut title = strip_html(title);
        if title.is_empty() {
            continue;
        }
        let mut source = feed.to_owned();
        // Google News titles end " - Publisher"; its description is only a
        // list of the same headlines, so it carries nothing worth keeping.
        let summary = if google {
            if let Some((t, publisher)) = title.rsplit_once(" - ") {
                source = publisher.trim().to_owned();
                title = t.trim().to_owned();
            }
            String::new()
        } else {
            strip_html(summary)
        };
        let url = safe_url(&link);
        out.push(Item {
            id: short_hash(&format!("{url}{title}")),
            kind: "news",
            title,
            summary,
            source,
            url,
            published: published.and_then(rfc3339_from_rfc2822),
            feed,
            ..Default::default()
        });
        if out.len() >= PER_FEED {
            break;
        }
    }
    Ok(out)
}

// ---- hazards -------------------------------------------------------------------

fn parse_json(text: &str) -> std::result::Result<Value, String> {
    serde_json::from_str(text).map_err(|_| "not JSON".to_owned())
}

pub fn parse_usgs(text: &str) -> std::result::Result<Vec<Item>, String> {
    let v = parse_json(text)?;
    let mut out = Vec::new();
    for f in v["features"].as_array().into_iter().flatten() {
        let p = &f["properties"];
        let c = &f["geometry"]["coordinates"];
        let (Some(lon), Some(lat)) = (c[0].as_f64(), c[1].as_f64()) else {
            continue;
        };
        let mag = p["mag"].as_f64().unwrap_or(0.0);
        let place = p["place"].as_str().unwrap_or("").to_owned();
        let depth = c[2]
            .as_f64()
            .map(|d| format!(", {d:.0} km deep"))
            .unwrap_or_default();
        let tsunami = if p["tsunami"].as_i64() == Some(1) {
            " Tsunami flag raised."
        } else {
            ""
        };
        out.push(Item {
            id: format!("usgs-{}", f["id"].as_str().unwrap_or("?")),
            kind: "quake",
            title: p["title"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("M {mag:.1} - {place}")),
            summary: format!("Magnitude {mag:.1} earthquake {place}{depth}.{tsunami}"),
            source: "USGS".to_owned(),
            url: safe_url(p["url"].as_str().unwrap_or("")),
            published: p["time"].as_i64().and_then(rfc3339_from_millis),
            lat: Some(lat),
            lon: Some(lon),
            place: Some(place),
            severity: Some(((mag - 2.5) / 5.0).clamp(0.05, 1.0)),
            feed: "USGS quakes",
            ..Default::default()
        });
    }
    Ok(out)
}

pub fn parse_eonet(text: &str) -> std::result::Result<Vec<Item>, String> {
    let v = parse_json(text)?;
    let mut out = Vec::new();
    for e in v["events"].as_array().into_iter().flatten() {
        let cat = e["categories"][0]["id"].as_str().unwrap_or("");
        let kind = match cat {
            "wildfires" => "fire",
            "severeStorms" => "storm",
            "volcanoes" => "volcano",
            "floods" | "landslides" | "earthquakes" => "alert",
            _ => continue, // sea ice, dust, etc.
        };
        // The latest point (storms carry a track; take where it is now).
        let Some(g) = e["geometry"].as_array().and_then(|g| g.last()) else {
            continue;
        };
        let (lon, lat) = match g["type"].as_str() {
            Some("Point") => (g["coordinates"][0].as_f64(), g["coordinates"][1].as_f64()),
            Some("Polygon") => centroid(&g["coordinates"][0]),
            _ => (None, None),
        };
        let (Some(lon), Some(lat)) = (lon, lat) else {
            continue;
        };
        let magnitude = match (g["magnitudeValue"].as_f64(), g["magnitudeUnit"].as_str()) {
            (Some(m), Some(u)) => format!(" Latest reading: {m:.0} {u}."),
            _ => String::new(),
        };
        let severity = match (kind, g["magnitudeValue"].as_f64()) {
            ("storm", Some(kts)) => (kts / 140.0).clamp(0.2, 1.0),
            ("fire", Some(acres)) => (acres / 100_000.0).clamp(0.2, 1.0),
            _ => 0.4,
        };
        out.push(Item {
            id: format!("eonet-{}", e["id"].as_str().unwrap_or("?")),
            kind,
            title: e["title"].as_str().unwrap_or("Event").to_owned(),
            summary: format!(
                "{} tracked by NASA EONET.{magnitude}",
                e["categories"][0]["title"]
                    .as_str()
                    .unwrap_or("Natural event")
            ),
            source: "NASA EONET".to_owned(),
            url: safe_url(e["sources"][0]["url"].as_str().unwrap_or("")),
            published: g["date"].as_str().map(str::to_owned),
            lat: Some(lat),
            lon: Some(lon),
            severity: Some(severity),
            feed: "NASA EONET",
            ..Default::default()
        });
    }
    Ok(out)
}

pub fn parse_calfire(text: &str) -> std::result::Result<Vec<Item>, String> {
    let v = parse_json(text)?;
    let mut out = Vec::new();
    for f in v.as_array().into_iter().flatten() {
        let (Some(lat), Some(lon)) = (f["Latitude"].as_f64(), f["Longitude"].as_f64()) else {
            continue;
        };
        if lat == 0.0 && lon == 0.0 {
            continue;
        }
        let name = f["Name"].as_str().unwrap_or("Fire").trim().to_owned();
        let county = f["County"].as_str().unwrap_or("").trim();
        let acres = f["AcresBurned"].as_f64();
        let contained = f["PercentContained"].as_f64();
        let mut summary = format!(
            "{} in {} County, California",
            f["Type"].as_str().unwrap_or("Incident"),
            if county.is_empty() {
                "an unnamed"
            } else {
                county
            }
        );
        if let Some(loc) = f["Location"].as_str().filter(|s| !s.trim().is_empty()) {
            summary.push_str(&format!(" ({})", loc.trim()));
        }
        summary.push('.');
        if let Some(a) = acres {
            summary.push_str(&format!(" {a:.0} acres burned."));
        }
        if let Some(c) = contained {
            summary.push_str(&format!(" {c:.0}% contained."));
        }
        if let Some(admin) = f["AdminUnit"].as_str().filter(|s| !s.is_empty()) {
            summary.push_str(&format!(" Lead: {admin}."));
        }
        let uncontained = 1.0 - contained.unwrap_or(0.0) / 100.0;
        out.push(Item {
            id: format!("calfire-{}", f["UniqueId"].as_str().unwrap_or(&name)),
            kind: "fire",
            title: name,
            summary,
            source: "CAL FIRE".to_owned(),
            url: safe_url(f["Url"].as_str().unwrap_or("")),
            published: f["Updated"].as_str().map(str::to_owned),
            lat: Some(lat),
            lon: Some(lon),
            place: Some(format!("{county} County, CA")),
            region: Some("CA".to_owned()),
            severity: Some(
                ((acres.unwrap_or(0.0) / 50_000.0).min(1.0) * 0.6 + uncontained * 0.4)
                    .clamp(0.15, 1.0),
            ),
            feed: "CAL FIRE",
        });
    }
    Ok(out)
}

/// InciWeb's wildfires (prescribed burns skipped), placed from the
/// degrees-minutes-seconds in the description. US only, so west is negative.
pub fn parse_inciweb(xml: &str) -> std::result::Result<Vec<Item>, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|_| "not XML".to_owned())?;
    let mut out = Vec::new();
    for node in doc.descendants().filter(|n| n.has_tag_name("item")) {
        let desc = child_text(node, "description").unwrap_or("");
        if !desc.contains("type of incident is Wildfire") {
            continue;
        }
        let (Some(lat), Some(lon)) = (dms_after(desc, "Latitude:"), dms_after(desc, "Longitude:"))
        else {
            continue;
        };
        let title = strip_html(child_text(node, "title").unwrap_or("Wildfire"));
        let state = desc
            .split("State:")
            .nth(1)
            .and_then(|s| s.lines().map(str::trim).find(|l| !l.is_empty()))
            .unwrap_or("")
            .to_owned();
        let overview = desc
            .split("Incident Overview:")
            .nth(1)
            .map(strip_html)
            .unwrap_or_default();
        let link = child_text(node, "link")
            .unwrap_or("")
            .replacen("http://", "https://", 1);
        out.push(Item {
            id: format!("inciweb-{}", short_hash(&link)),
            kind: "fire",
            title,
            summary: if overview.is_empty() {
                format!("Wildfire in {state}.")
            } else {
                overview
            },
            source: "InciWeb".to_owned(),
            url: safe_url(&link),
            published: desc
                .split("Last updated:")
                .nth(1)
                .and_then(|s| s.split_whitespace().next())
                .map(|d| format!("{d}T12:00:00Z")),
            lat: Some(lat),
            lon: Some(-lon.abs()),
            place: (!state.is_empty()).then_some(state),
            severity: Some(0.45),
            feed: "InciWeb",
            ..Default::default()
        });
    }
    Ok(out)
}

/// `Latitude: 35° 11 8.9` → 35.1858.
fn dms_after(s: &str, label: &str) -> Option<f64> {
    let rest = s.split(label).nth(1)?;
    let nums: Vec<f64> = rest
        .split(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-'))
        .filter(|t| !t.is_empty())
        .take(3)
        .filter_map(|t| t.parse().ok())
        .collect();
    let d = *nums.first()?;
    let m = nums.get(1).copied().unwrap_or(0.0);
    let sec = nums.get(2).copied().unwrap_or(0.0);
    let v = d.abs() + m / 60.0 + sec / 3600.0;
    (v <= 180.0).then_some(if d < 0.0 { -v } else { v })
}

/// Severe and extreme NWS alerts, one per event type and state (a front
/// raises dozens of county alerts). Placed by polygon when there is one,
/// otherwise by the state of its first zone code (`IAZ040` → IA).
pub fn parse_nws(text: &str) -> std::result::Result<Vec<Item>, String> {
    let v = parse_json(text)?;
    let mut grouped: Vec<Item> = Vec::new();
    let mut index: HashMap<(String, String), usize> = HashMap::new();
    let mut counts: Vec<usize> = Vec::new();
    for f in v["features"].as_array().into_iter().flatten() {
        let p = &f["properties"];
        let event = p["event"].as_str().unwrap_or("Alert").to_owned();
        let state = p["geocode"]["UGC"][0]
            .as_str()
            .map(|u| u.chars().take(2).collect::<String>())
            .unwrap_or_default();
        let (lon, lat) = if f["geometry"]["type"].as_str() == Some("Polygon") {
            centroid(&f["geometry"]["coordinates"][0])
        } else {
            (None, None)
        };
        let key = (event.clone(), state.clone());
        if let Some(&i) = index.get(&key) {
            counts[i] += 1;
            if grouped[i].lat.is_none() && lat.is_some() {
                grouped[i].lat = lat;
                grouped[i].lon = lon;
            }
            continue;
        }
        let severity = if p["severity"].as_str() == Some("Extreme") {
            0.9
        } else {
            0.55
        };
        index.insert(key, grouped.len());
        counts.push(1);
        grouped.push(Item {
            id: format!("nws-{}", short_hash(p["id"].as_str().unwrap_or(&event))),
            kind: if is_storm(&event) { "storm" } else { "alert" },
            title: p["headline"].as_str().unwrap_or(&event).to_owned(),
            summary: clip(
                &format!(
                    "{event}. Areas: {}. {}",
                    p["areaDesc"].as_str().unwrap_or(""),
                    p["description"]
                        .as_str()
                        .unwrap_or("")
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                ),
                MAX_SUMMARY,
            ),
            source: "National Weather Service".to_owned(),
            url: "https://alerts.weather.gov/".to_owned(),
            published: p["sent"].as_str().map(str::to_owned),
            lat,
            lon,
            place: Some(event),
            region: (!state.is_empty()).then_some(state),
            severity: Some(severity),
            feed: "NWS alerts",
        });
    }
    for (item, n) in grouped.iter_mut().zip(counts) {
        if n > 1 {
            item.summary = clip(&format!("{n} active alerts. {}", item.summary), MAX_SUMMARY);
        }
    }
    Ok(grouped)
}

fn is_storm(event: &str) -> bool {
    let e = event.to_lowercase();
    [
        "tornado",
        "thunderstorm",
        "hurricane",
        "tropical",
        "storm",
        "blizzard",
        "wind",
    ]
    .iter()
    .any(|w| e.contains(w))
}

/// Mean of a ring's vertices: close enough to put a dot on.
fn centroid(ring: &Value) -> (Option<f64>, Option<f64>) {
    let pts: Vec<(f64, f64)> = ring
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| Some((p[0].as_f64()?, p[1].as_f64()?)))
        .collect();
    if pts.is_empty() {
        return (None, None);
    }
    let n = pts.len() as f64;
    (
        Some(pts.iter().map(|p| p.0).sum::<f64>() / n),
        Some(pts.iter().map(|p| p.1).sum::<f64>() / n),
    )
}

// ---- Wikipedia -------------------------------------------------------------------

pub fn parse_wikipedia(body: &[u8]) -> std::result::Result<Vec<Entry>, String> {
    let v: Value = serde_json::from_slice(body).map_err(|_| "not JSON".to_owned())?;
    let mut pages: Vec<&Value> = v["query"]["pages"]
        .as_array()
        .into_iter()
        .flatten()
        .collect();
    pages.sort_by_key(|p| p["index"].as_i64().unwrap_or(i64::MAX));
    Ok(pages
        .into_iter()
        .filter_map(|p| {
            let title = p["title"].as_str()?.to_owned();
            let id = p["pageid"].as_i64()?;
            Some(Entry {
                description: p["description"].as_str().unwrap_or("").to_owned(),
                extract: clip(p["extract"].as_str().unwrap_or("").trim(), MAX_SUMMARY),
                url: format!("https://en.wikipedia.org/?curid={id}"),
                title,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rss_items_are_plain_text_with_safe_links() {
        let xml = r#"<?xml version="1.0"?><rss><channel>
          <item><title>Fire near &lt;b&gt;Malibu&lt;/b&gt;</title>
            <link>https://example.com/a</link>
            <description>&lt;p&gt;Crews &amp;amp; planes &lt;script&gt;x&lt;/script&gt;respond&amp;nbsp;now&lt;/p&gt;</description>
            <pubDate>Fri, 16 Oct 2026 22:35:00 GMT</pubDate></item>
          <item><title>Bad link</title><link>javascript:alert(1)</link></item>
        </channel></rss>"#;
        let items = parse_rss("NPR", xml).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "Fire near Malibu");
        assert_eq!(items[0].summary, "Crews & planes x respond now");
        assert_eq!(items[0].url, "https://example.com/a");
        assert_eq!(items[0].published.as_deref(), Some("2026-10-16T22:35:00Z"));
        assert_eq!(items[1].url, "");
    }

    #[test]
    fn google_titles_lose_the_publisher_suffix() {
        let xml = r#"<rss><channel><item><title>Oregon school shooting - The Guardian</title>
          <link>https://news.google.com/x</link><description>&lt;ol&gt;&lt;li&gt;dup&lt;/li&gt;&lt;/ol&gt;</description></item></channel></rss>"#;
        let items = parse_rss("Google News · Top", xml).unwrap();
        assert_eq!(items[0].title, "Oregon school shooting");
        assert_eq!(items[0].source, "The Guardian");
        assert_eq!(items[0].summary, "");
    }

    #[test]
    fn atom_entries_parse() {
        let xml = r#"<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Quake felt in Tokyo</title>
          <link href="https://example.com/q"/><summary>Strong shaking</summary>
          <updated>2026-10-16T01:02:03Z</updated></entry></feed>"#;
        let items = parse_rss("Atom", xml).unwrap();
        assert_eq!(items[0].url, "https://example.com/q");
        assert_eq!(items[0].summary, "Strong shaking");
        assert_eq!(items[0].published.as_deref(), Some("2026-10-16T01:02:03Z"));
    }

    #[test]
    fn inciweb_coordinates_are_degrees_minutes_seconds_west() {
        let xml = "<rss><channel><item><title>Ridge Fire</title><link>http://inciweb.wildfire.gov/x</link>\
          <description>Last updated: 2026-10-07\n---\nThe type of incident is Wildfire and involves\n---\nState: Arizona\n---\n\
          Latitude: 35° 11 8.9  Longitude: 111° 40 26 \n---\nIncident Overview: Crews are working.</description></item>\
          <item><title>Burn</title><description>The type of incident is Prescribed Fire Latitude: 1 Longitude: 2</description></item></channel></rss>";
        let items = parse_inciweb(xml).unwrap();
        assert_eq!(items.len(), 1);
        assert!((items[0].lat.unwrap() - 35.1858).abs() < 0.001);
        assert!((items[0].lon.unwrap() + 111.6739).abs() < 0.001);
        assert_eq!(items[0].place.as_deref(), Some("Arizona"));
        assert_eq!(items[0].url, "https://inciweb.wildfire.gov/x");
    }

    #[test]
    fn nws_alerts_group_by_event_and_state() {
        let a = |id: &str, ugc: &str| {
            serde_json::json!({"geometry": null, "properties": {"id": id, "event": "Flood Warning",
              "headline": "Flood Warning", "severity": "Severe", "areaDesc": "Linn", "geocode": {"UGC": [ugc]}}})
        };
        let text =
            serde_json::json!({"features": [a("1", "IAZ040"), a("2", "IAZ041"), a("3", "TXZ001")]})
                .to_string();
        let items = parse_nws(&text).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].region.as_deref(), Some("IA"));
        assert!(items[0].summary.starts_with("2 active alerts."));
    }

    #[test]
    fn queries_are_bounded() {
        assert_eq!(clean_query("  Jane   Doe "), Some("Jane Doe".into()));
        assert_eq!(clean_query("   "), None);
        assert_eq!(clean_query(&"x".repeat(81)), None);
    }

    #[test]
    fn wikipedia_entries_keep_search_order() {
        let body = serde_json::json!({"query": {"pages": [
            {"pageid": 2, "index": 2, "title": "Michael Jordan (footballer)", "description": "English footballer"},
            {"pageid": 1, "index": 1, "title": "Michael Jordan", "description": "American basketball player", "extract": "Michael Jeffrey Jordan is..."}
        ]}}).to_string();
        let e = parse_wikipedia(body.as_bytes()).unwrap();
        assert_eq!(e[0].title, "Michael Jordan");
        assert_eq!(e[1].url, "https://en.wikipedia.org/?curid=2");
    }
}
