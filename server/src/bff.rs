//! `/bff/v1/*` → the Opus Systems OS API with this site's own key. The page
//! never sees a key; it sees an unlocked cookie, and this passthrough adds
//! the `Authorization` header on the way out.
//!
//! Only an allowlist of API areas is reachable, and key management and
//! pairing never are — whatever scopes the `web` key happens to hold. Bodies
//! stream both ways, so the session SSE feed passes through as it arrives.

use crate::error::{Error, Result};
use crate::request_id::{RequestId, HEADER as REQUEST_ID};
use crate::AppState;
use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderName};
use axum::response::Response;
use axum::Extension;
use futures_util::TryStreamExt;

/// First path segment → reachable. Everything else is a 404 here.
const ALLOWED_AREAS: &[&str] = &[
    "me", "fleet", "rig", "sessions", "usage", "voice", "ops", "sources", "briefing", "clients",
];
/// Never reachable, at any depth.
const FORBIDDEN_SEGMENTS: &[&str] = &["keys", "pair"];
/// Request bodies are small JSON (events, tool results, text to speak).
const MAX_REQUEST_BYTES: usize = 1 << 20;

const FORWARD_REQUEST: &[HeaderName] = &[header::CONTENT_TYPE, header::ACCEPT];
const FORWARD_RESPONSE: &[HeaderName] = &[
    header::CONTENT_TYPE,
    header::CACHE_CONTROL,
    header::RETRY_AFTER,
];

fn segment_ok(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

/// The API path for `rest` (what follows `/bff/v1/`), or `None` when it may
/// not be proxied.
pub fn allowed_path(rest: &str) -> Option<String> {
    let segments: Vec<&str> = rest.split('/').collect();
    let first = *segments.first()?;
    if !ALLOWED_AREAS.contains(&first) {
        return None;
    }
    if segments
        .iter()
        .any(|s| !segment_ok(s) || FORBIDDEN_SEGMENTS.contains(s))
    {
        return None;
    }
    Some(format!("/v1/{}", segments.join("/")))
}

pub async fn proxy(
    State(state): State<AppState>,
    Extension(RequestId(request_id)): Extension<RequestId>,
    Path(rest): Path<String>,
    req: Request,
) -> Result<Response> {
    let path = allowed_path(&rest).ok_or(Error::NotFound)?;
    let (parts, body) = req.into_parts();
    let mut url = format!("{}{}", state.config.api_url, path);
    if let Some(q) = parts.uri.query() {
        url.push('?');
        url.push_str(q);
    }

    let body = axum::body::to_bytes(body, MAX_REQUEST_BYTES)
        .await
        .map_err(|_| Error::InvalidRequest("request body too large".to_owned()))?;

    let mut out = state
        .http
        .request(parts.method.clone(), &url)
        .bearer_auth(&state.config.api_key)
        .header(REQUEST_ID, &request_id);
    for name in FORWARD_REQUEST {
        if let Some(v) = parts.headers.get(name) {
            out = out.header(name, v);
        }
    }
    if let Some(v) = parts.headers.get("last-event-id") {
        out = out.header("last-event-id", v);
    }
    if !body.is_empty() {
        out = out.body(body);
    }

    let upstream = out.send().await?;
    let mut res = Response::builder().status(upstream.status().as_u16());
    for name in FORWARD_RESPONSE {
        if let Some(v) = upstream.headers().get(name) {
            res = res.header(name, v);
        }
    }
    // Event streams must not be buffered by Caddy or anything else.
    let is_sse = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.starts_with("text/event-stream"));
    if is_sse {
        res = res.header("x-accel-buffering", "no");
    }
    let stream = upstream.bytes_stream().map_err(std::io::Error::other);
    res.body(Body::from_stream(stream))
        .map_err(|e| Error::Internal(format!("response: {e}")))
}

#[cfg(test)]
mod tests {
    use super::allowed_path;

    #[test]
    fn allowlist() {
        assert_eq!(allowed_path("me").as_deref(), Some("/v1/me"));
        assert_eq!(
            allowed_path("sessions/sesn_01ABC/stream").as_deref(),
            Some("/v1/sessions/sesn_01ABC/stream")
        );
        assert_eq!(
            allowed_path("voice/speak").as_deref(),
            Some("/v1/voice/speak")
        );
        for denied in [
            "keys",
            "keys/abc",
            "pair",
            "pair/123/approve",
            "sessions/pair",
            "fleet/../keys",
            "fleet/./agents",
            "fleet//agents",
            "",
            "openapi.json",
            "docs",
            "health",
            "fleet/%2e%2e",
        ] {
            assert_eq!(allowed_path(denied), None, "{denied}");
        }
    }
}
