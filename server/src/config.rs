//! Environment-driven config. On the droplet these live in Iron-Fleet's
//! `deploy/droplet/.env` beside every other service's; nothing secret is in
//! this (public) repository.

use crate::error::{Error, Result};
use secrecy::SecretString;
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
    /// Zeroed when dropped and redacted from any `Debug`; read from a
    /// secrets file on the droplet (`WEB_API_KEY_FILE`), not the env.
    pub api_key: SecretString,
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
    /// An unlocked session nobody has used for this long locks.
    pub session_idle_minutes: u32,
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
            .field("session_idle_minutes", &self.session_idle_minutes)
            .finish_non_exhaustive()
    }
}

/// `DATABASE_PATH`, or `jarvis-web.db` here.
pub fn database_path() -> PathBuf {
    optional("DATABASE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("jarvis-web.db"))
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

/// An `osk_` key: from the file `<NAME>_FILE` names (a Docker secret,
/// `/run/secrets/…`) when set, else from `<NAME>` itself with a warning —
/// env values show in `docker inspect` and `/proc/*/environ`.
fn api_key(name: &str) -> Result<Option<SecretString>> {
    let file_var = format!("{name}_FILE");
    let key = key_from(&file_var, optional(&file_var), optional(name))?;
    if key.is_some() && optional(&file_var).is_none() {
        tracing::warn!(
            "{name} is read from the environment; move it to a secrets file ({file_var})"
        );
    }
    Ok(key)
}

/// The key in `file` when it names one (which must hold a key), else `env`.
fn key_from(
    file_var: &str,
    file: Option<String>,
    env: Option<String>,
) -> Result<Option<SecretString>> {
    let Some(path) = file else {
        return Ok(env.map(SecretString::from));
    };
    let key = std::fs::read_to_string(&path)
        .map_err(|e| Error::Config(format!("{file_var}: read {path}: {e}")))?;
    let key = key.trim();
    if key.is_empty() {
        return Err(Error::Config(format!("{file_var}: {path} is empty")));
    }
    Ok(Some(SecretString::from(key.to_owned())))
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
            api_key: api_key("WEB_API_KEY")?.ok_or_else(|| {
                Error::Config("WEB_API_KEY_FILE (or WEB_API_KEY) is not set".to_owned())
            })?,
            full: true,
        }];
        match (
            optional("JARVIS_WEB_POWERS_PASSWORD_HASH"),
            api_key("WEB_POWERS_API_KEY")?,
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
                    "Mr. Powers's profile needs both JARVIS_WEB_POWERS_PASSWORD_HASH and WEB_POWERS_API_KEY_FILE (or neither)"
                        .to_owned(),
                ))
            }
        }
        Ok(Config {
            port: number("PORT", 8200)?,
            database_path: database_path(),
            api_url: required("OPUS_API_URL")?.trim_end_matches('/').to_owned(),
            profiles,
            static_dir: optional("STATIC_DIR").map(PathBuf::from),
            session_hours: number("SESSION_HOURS", 12)?,
            session_idle_minutes: number("SESSION_IDLE_MINUTES", 120)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::key_from;
    use secrecy::ExposeSecret;

    #[test]
    fn a_key_file_wins_over_the_env_and_must_hold_a_key() {
        let dir = std::env::temp_dir().join(format!(
            "jw-key-{}",
            crate::hex(&crate::random_bytes::<8>())
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("web_api_key");
        std::fs::write(&file, "osk_file0000_secret\n").unwrap();
        let path = Some(file.to_string_lossy().into_owned());

        let k = key_from("K_FILE", path.clone(), Some("osk_env00000_secret".into())).unwrap();
        assert_eq!(k.unwrap().expose_secret(), "osk_file0000_secret");
        let k = key_from("K_FILE", None, Some("osk_env00000_secret".into())).unwrap();
        assert_eq!(k.unwrap().expose_secret(), "osk_env00000_secret");
        assert!(key_from("K_FILE", None, None).unwrap().is_none());

        std::fs::write(&file, "  \n").unwrap();
        assert!(key_from("K_FILE", path, None).is_err());
        assert!(key_from(
            "K_FILE",
            Some(dir.join("missing").to_string_lossy().into_owned()),
            None
        )
        .is_err());
        let _ = std::fs::remove_dir_all(&dir);

        // Never printed by accident.
        let k = key_from("K_FILE", None, Some("osk_env00000_secret".into()))
            .unwrap()
            .unwrap();
        assert!(!format!("{k:?}").contains("secret0"));
        assert!(!format!("{k:?}").contains("osk_env"));
    }
}
