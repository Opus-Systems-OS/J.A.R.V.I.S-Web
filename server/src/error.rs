//! One error type, one wire shape — the same envelope the Opus Systems OS API
//! uses, so the page parses a single error format whether the failure is
//! ours or the API's (whose bodies pass through `/bff` untouched):
//!
//! ```json
//! {"error":{"type":"unauthorized","message":"…","request_id":"req_…"}}
//! ```
//!
//! `Error::into_response` sets the status and attaches the envelope as a
//! response extension; `request_id::layer` writes the final body, because
//! only it knows the id.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    // Startup only — never reaches a response.
    #[error("config: {0}")]
    Config(String),

    // Caller errors.
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden: {0}")]
    Forbidden(&'static str),
    #[error("not found")]
    NotFound,
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("rate limited")]
    RateLimited { retry_after_secs: u32 },

    // Our side / upstream.
    #[error("database: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("internal: {0}")]
    Internal(String),
    #[error("upstream transport: {0}")]
    UpstreamTransport(#[from] reqwest::Error),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// The envelope body minus the request id, carried as a response extension
/// from `Error::into_response` to `request_id::layer`.
#[derive(Debug, Clone, Serialize)]
pub struct Envelope {
    #[serde(rename = "type")]
    pub kind: String,
    pub message: String,
}

impl Error {
    pub fn kind(&self) -> &'static str {
        match self {
            Error::Config(_) | Error::Db(_) | Error::Internal(_) => "internal",
            Error::Unauthorized => "unauthorized",
            Error::Forbidden(_) => "forbidden",
            Error::NotFound => "not_found",
            Error::InvalidRequest(_) => "invalid_request",
            Error::RateLimited { .. } => "rate_limited",
            Error::UpstreamTransport(_) => "upstream",
        }
    }

    pub fn status(&self) -> StatusCode {
        match self {
            Error::Config(_) | Error::Db(_) | Error::Internal(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
            Error::Unauthorized => StatusCode::UNAUTHORIZED,
            Error::Forbidden(_) => StatusCode::FORBIDDEN,
            Error::NotFound => StatusCode::NOT_FOUND,
            Error::InvalidRequest(_) => StatusCode::BAD_REQUEST,
            Error::RateLimited { .. } => StatusCode::TOO_MANY_REQUESTS,
            Error::UpstreamTransport(_) => StatusCode::BAD_GATEWAY,
        }
    }

    /// Message safe to return. Internal failures are not echoed.
    fn public_message(&self) -> String {
        match self {
            Error::Config(_) | Error::Db(_) | Error::Internal(_) => "internal error".to_owned(),
            Error::UpstreamTransport(_) => "could not reach the Opus Systems OS API".to_owned(),
            Error::RateLimited { retry_after_secs } => {
                format!("too many attempts; try again in {retry_after_secs} s")
            }
            other => other.to_string(),
        }
    }

    pub fn envelope(&self) -> Envelope {
        Envelope {
            kind: self.kind().to_owned(),
            message: self.public_message(),
        }
    }
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let status = self.status();
        if status.is_server_error() {
            tracing::error!(error = %self, kind = self.kind(), "request failed");
        } else {
            tracing::warn!(error = %self, kind = self.kind(), "request rejected");
        }
        let mut res = status.into_response();
        if let Error::RateLimited { retry_after_secs } = &self {
            if let Ok(v) = retry_after_secs.to_string().parse() {
                res.headers_mut().insert(http::header::RETRY_AFTER, v);
            }
        }
        res.extensions_mut().insert(self.envelope());
        res
    }
}

/// Envelope for a response axum produced on its own (extractor rejections,
/// no matching route or method).
pub fn envelope_for_status(status: StatusCode, text: &str) -> Envelope {
    let kind = match status {
        StatusCode::NOT_FOUND => "not_found",
        StatusCode::METHOD_NOT_ALLOWED => "method_not_allowed",
        StatusCode::UNAUTHORIZED => "unauthorized",
        StatusCode::FORBIDDEN => "forbidden",
        StatusCode::TOO_MANY_REQUESTS => "rate_limited",
        s if s.is_client_error() => "invalid_request",
        _ => "internal",
    };
    let message = match status {
        StatusCode::NOT_FOUND if text.is_empty() => "no such route".to_owned(),
        StatusCode::METHOD_NOT_ALLOWED if text.is_empty() => "method not allowed".to_owned(),
        _ if text.is_empty() => status
            .canonical_reason()
            .unwrap_or("error")
            .to_ascii_lowercase(),
        _ => text.to_owned(),
    };
    Envelope {
        kind: kind.to_owned(),
        message,
    }
}
