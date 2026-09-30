//! Environment-driven config. On the droplet these live in Iron-Fleet's
//! `deploy/droplet/.env` beside every other service's; nothing secret is in
//! this (public) repository.

use crate::error::{Error, Result};
use std::path::PathBuf;

/// Someone who can unlock the HUD. Each has their own password, their own
/// API key (so the API, not this site, decides what they can reach), their
/// own reminders, visits and microphone lease.
#[derive(Clone)]
pub struct Profile {
    /// `walker` or `powers`: stored with each unlocked session.
    pub id: String,
    /// How Jarvis addresses them: "Mr. Walker".
    pub name: String,
    /// Argon2id PHC string from `jarvis-web hash-password`.
    pub password_hash: String,
    /// Their `osk_` key. Sent upstream by `/bff`, never to a browser.
    pub api_key: String,
    /// The owner's profile: every area of the API, the credit ledger and
    /// the briefing. Anyone else gets the least-privilege set (`bff`).
    pub full: bool,
}

impl std::fmt::Debug for Profile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Profile")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("full", &self.full)
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub struct Config {
    pub port: u16,
    pub database_path: PathBuf,
    /// The Opus Systems OS API on the compose network: `http://api:8100`.
    pub api_url: String,
    /// Mr. Walker first (the owner, always present), then Mr. Powers when
    /// his two variables are set.
    pub profiles: Vec<Profile>,
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
            .field("profiles", &self.profiles)
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

fn argon2_hash(name: &str, value: String) -> Result<String> {
    if value.starts_with("$argon2id$") {
        Ok(value)
    } else {
        Err(Error::Config(format!(
            "{name} must be an Argon2id PHC string from `jarvis-web hash-password`"
        )))
    }
}

impl Config {
    pub fn profile(&self, id: &str) -> Option<&Profile> {
        self.profiles.iter().find(|p| p.id == id)
    }

    /// The owner's profile, whose key reads the site-wide things (the Fish
    /// credit for the ledger).
    pub fn owner(&self) -> &Profile {
        &self.profiles[0]
    }

    pub fn from_env() -> Result<Self> {
        let mut profiles = vec![Profile {
            id: "walker".to_owned(),
            name: "Mr. Walker".to_owned(),
            password_hash: argon2_hash(
                "JARVIS_WEB_PASSWORD_HASH",
                required("JARVIS_WEB_PASSWORD_HASH")?,
            )?,
            api_key: required("WEB_API_KEY")?,
            full: true,
        }];
        match (
            optional("JARVIS_WEB_POWERS_PASSWORD_HASH"),
            optional("WEB_POWERS_API_KEY"),
        ) {
            (Some(hash), Some(key)) => profiles.push(Profile {
                id: "powers".to_owned(),
                name: "Mr. Powers".to_owned(),
                password_hash: argon2_hash("JARVIS_WEB_POWERS_PASSWORD_HASH", hash)?,
                api_key: key,
                full: false,
            }),
            (None, None) => {}
            _ => {
                return Err(Error::Config(
                    "Mr. Powers's profile needs both JARVIS_WEB_POWERS_PASSWORD_HASH and WEB_POWERS_API_KEY (or neither)"
                        .to_owned(),
                ))
            }
        }
        Ok(Config {
            port: number("PORT", 8200)?,
            database_path: optional("DATABASE_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("jarvis-web.db")),
            api_url: required("OPUS_API_URL")?.trim_end_matches('/').to_owned(),
            profiles,
            static_dir: optional("STATIC_DIR").map(PathBuf::from),
            session_hours: number("SESSION_HOURS", 12)?,
        })
    }
}
