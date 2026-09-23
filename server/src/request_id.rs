//! `x-request-id` on every request and response, in every log line, and in
//! every error body. The id is forwarded to the API on `/bff` calls, so one
//! id follows a request from the page to the control plane's logs.

use crate::error::{envelope_for_status, Envelope};
use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, HeaderValue};
use axum::middleware::Next;
use axum::response::Response;
use http_body_util::BodyExt;
use tracing::Instrument;

pub const HEADER: &str = "x-request-id";

#[derive(Debug, Clone)]
pub struct RequestId(pub String);

fn generate() -> String {
    format!("req_{}", crate::hex(&crate::random_bytes::<8>()))
}

fn acceptable(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub async fn layer(mut req: Request, next: Next) -> Response {
    let id = req
        .headers()
        .get(HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|v| acceptable(v))
        .map(str::to_owned)
        .unwrap_or_else(generate);
    req.extensions_mut().insert(RequestId(id.clone()));

    let span = tracing::info_span!(
        "request",
        request_id = %id,
        method = %req.method(),
        path = %req.uri().path(),
    );
    let res = next.run(req).instrument(span).await;
    let mut res = finalize_error_body(res, &id).await;
    if let Ok(v) = HeaderValue::from_str(&id) {
        res.headers_mut().insert(HEADER, v);
    }
    res
}

/// Turn an error response into the envelope. Our `Error` leaves the envelope
/// in an extension; axum's own rejections are plain text. JSON error bodies
/// from the API (already enveloped) and every 2xx — streams included — pass
/// through untouched.
async fn finalize_error_body(res: Response, request_id: &str) -> Response {
    let status = res.status();
    if !(status.is_client_error() || status.is_server_error()) {
        return res;
    }
    if let Some(e) = res.extensions().get::<Envelope>().cloned() {
        let (parts, _) = res.into_parts();
        return build(parts, e, request_id);
    }
    let is_text = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| ct.starts_with("text/plain"))
        .unwrap_or(true);
    if !is_text {
        return res;
    }
    let (parts, body) = res.into_parts();
    let text = match body.collect().await {
        Ok(b) => String::from_utf8_lossy(&b.to_bytes()).trim().to_owned(),
        Err(_) => String::new(),
    };
    let envelope = envelope_for_status(status, &text);
    build(parts, envelope, request_id)
}

fn build(mut parts: http::response::Parts, envelope: Envelope, request_id: &str) -> Response {
    let body = serde_json::json!({
        "error": {
            "type": envelope.kind,
            "message": envelope.message,
            "request_id": request_id,
        }
    });
    let bytes = Bytes::from(serde_json::to_vec(&body).unwrap_or_default());
    parts.headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    parts.headers.remove(header::CONTENT_LENGTH);
    if let Ok(v) = HeaderValue::from_str(&bytes.len().to_string()) {
        parts.headers.insert(header::CONTENT_LENGTH, v);
    }
    Response::from_parts(parts, Body::from(bytes))
}
