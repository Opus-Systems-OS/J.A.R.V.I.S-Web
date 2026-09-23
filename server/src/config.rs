//! Environment-driven config. On the droplet these live in Iron-Fleet's
//! `deploy/droplet/.env` beside every other service's; nothing secret is in
//! this (public) repository.

use crate::error::{Error, Result};
use std::path::PathBuf;

#[derive(Clone)]
pub struct Config {
    pub port: u16,
    pub database_path: PathBuf,
    /// The Opus Systems OS API on the compose network: `http://api:8100`.
    pub api_url: String,
    /// This site's own `osk_` key. Sent upstream by `/bff`, never to a
    /// browser.
    pub api_key: String,
    /// Argon2id PHC string from `jarvis-web hash-password`.
    pub password_hash: String,
    /// Built page (`web/dist`); `None` serves the API surface only.
    pub static_dir: Option<PathBuf>,
    /// Lifetime of an unlocked session.
    pub session_hours: u32,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("port", &self.port)
            .field("database_path", &self.database_path)
            .field("api_url", &self.api_url)
            .field("static_dir", &self.static_dir)
            .field("session_hours", &self.session_hours)
            .finish_non_exhaustive()
    }
}

fn required(name: &str) -> Result<String> {
    optional(name).ok_or_else(|| Error::Config(format!("{name} is not set")))
}

fn optional(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn number<T: std::str::FromStr>(name: &str, default: T) -> Result<T> {
    optional(name)
        .map(|v| {
            v.parse::<T>()
                .map_err(|_| Error::Config(format!("{name} must be a number, got {v:?}")))
        })
        .transpose()
        .map(|v| v.unwrap_or(default))
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let password_hash = required("JARVIS_WEB_PASSWORD_HASH")?;
        if !password_hash.starts_with("$argon2id$") {
            return Err(Error::Config(
                "JARVIS_WEB_PASSWORD_HASH must be an Argon2id PHC string from `jarvis-web hash-password`"
                    .to_owned(),
            ));
        }
        Ok(Config {
            port: number("PORT", 8200)?,
            database_path: optional("DATABASE_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("jarvis-web.db")),
            api_url: required("OPUS_API_URL")?.trim_end_matches('/').to_owned(),
            api_key: required("WEB_API_KEY")?,
            password_hash,
            static_dir: optional("STATIC_DIR").map(PathBuf::from),
            session_hours: number("SESSION_HOURS", 12)?,
        })
    }
}
