//! SQLite for what this site owns: unlocked browser sessions, failed unlock
//! attempts, and the credit ledger — the Anthropic balance you typed after a
//! top-up and your warning thresholds. Fleet state, usage and everything
//! Jarvis knows are read live through the API — never stored here. Times
//! are unix seconds.

use crate::error::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::{Arc, Mutex};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS web_sessions (
  token_sha256  TEXT PRIMARY KEY,   -- hex; the cookie holds the 256-bit token
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  ip            TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_failures (
  ip   TEXT NOT NULL,
  at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_failures_at ON login_failures (at);
CREATE TABLE IF NOT EXISTS credit_settings (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  anchor_cents          INTEGER,            -- the Console balance you typed
  anchored_at           INTEGER,            -- when you typed it
  anthropic_warn_cents  INTEGER NOT NULL DEFAULT 1000,
  fish_warn_cents       INTEGER NOT NULL DEFAULT 200
);
INSERT OR IGNORE INTO credit_settings (id) VALUES (1);
"#;

/// The ledger's one row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreditSettings {
    pub anchor_cents: Option<i64>,
    pub anchored_at: Option<i64>,
    pub anthropic_warn_cents: i64,
    pub fish_warn_cents: i64,
}

/// A partial update; `None` leaves a field as it is.
#[derive(Debug, Default)]
pub struct CreditPatch {
    pub anchor_cents: Option<i64>,
    pub anthropic_warn_cents: Option<i64>,
    pub fish_warn_cents: Option<i64>,
}

#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

pub fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    rusqlite::Error::InvalidPath(std::path::PathBuf::from(format!(
                        "{}: {e}",
                        parent.display()
                    )))
                })?;
            }
        }
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        Self::init(conn)
    }

    pub fn in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch(SCHEMA)?;
        Ok(Db {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        Ok(f(&conn)?)
    }

    // ---- sessions ------------------------------------------------------------

    pub fn insert_session(&self, token_sha256: &str, ttl_secs: i64, ip: &str) -> Result<()> {
        let now = now();
        self.with(|c| {
            // Expired rows go whenever a new one arrives; there are few.
            c.execute("DELETE FROM web_sessions WHERE expires_at <= ?1", [now])?;
            c.execute(
                "INSERT INTO web_sessions (token_sha256, created_at, expires_at, ip)
                 VALUES (?1, ?2, ?3, ?4)",
                params![token_sha256, now, now + ttl_secs, ip],
            )?;
            Ok(())
        })
    }

    pub fn session_valid(&self, token_sha256: &str) -> Result<bool> {
        self.with(|c| {
            c.query_row(
                "SELECT 1 FROM web_sessions WHERE token_sha256 = ?1 AND expires_at > ?2",
                params![token_sha256, now()],
                |_| Ok(()),
            )
            .optional()
            .map(|r| r.is_some())
        })
    }

    pub fn delete_session(&self, token_sha256: &str) -> Result<()> {
        self.with(|c| {
            c.execute(
                "DELETE FROM web_sessions WHERE token_sha256 = ?1",
                [token_sha256],
            )
            .map(|_| ())
        })
    }

    // ---- unlock attempts -----------------------------------------------------

    pub fn record_failure(&self, ip: &str) -> Result<()> {
        let now = now();
        self.with(|c| {
            c.execute(
                "DELETE FROM login_failures WHERE at <= ?1",
                [now - 24 * 3600],
            )?;
            c.execute(
                "INSERT INTO login_failures (ip, at) VALUES (?1, ?2)",
                params![ip, now],
            )
            .map(|_| ())
        })
    }

    /// Failures from `ip` (or from anyone, with `None`) since `since`, and the
    /// oldest of them — the moment the window starts to free up.
    pub fn failures_since(&self, ip: Option<&str>, since: i64) -> Result<(u32, Option<i64>)> {
        self.with(|c| match ip {
            Some(ip) => c.query_row(
                "SELECT COUNT(*), MIN(at) FROM login_failures WHERE ip = ?1 AND at > ?2",
                params![ip, since],
                |r| Ok((r.get(0)?, r.get(1)?)),
            ),
            None => c.query_row(
                "SELECT COUNT(*), MIN(at) FROM login_failures WHERE at > ?1",
                params![since],
                |r| Ok((r.get(0)?, r.get(1)?)),
            ),
        })
    }

    pub fn clear_failures(&self, ip: &str) -> Result<()> {
        self.with(|c| {
            c.execute("DELETE FROM login_failures WHERE ip = ?1", [ip])
                .map(|_| ())
        })
    }

    // ---- credit ledger -------------------------------------------------------

    pub fn credits(&self) -> Result<CreditSettings> {
        self.with(|c| {
            c.query_row(
                "SELECT anchor_cents, anchored_at, anthropic_warn_cents, fish_warn_cents
                 FROM credit_settings WHERE id = 1",
                [],
                |r| {
                    Ok(CreditSettings {
                        anchor_cents: r.get(0)?,
                        anchored_at: r.get(1)?,
                        anthropic_warn_cents: r.get(2)?,
                        fish_warn_cents: r.get(3)?,
                    })
                },
            )
        })
    }

    /// Apply `patch`. A new anchor is stamped with the current time.
    pub fn set_credits(&self, patch: &CreditPatch) -> Result<()> {
        let now = now();
        self.with(|c| {
            if let Some(cents) = patch.anchor_cents {
                c.execute(
                    "UPDATE credit_settings SET anchor_cents = ?1, anchored_at = ?2 WHERE id = 1",
                    params![cents, now],
                )?;
            }
            if let Some(cents) = patch.anthropic_warn_cents {
                c.execute(
                    "UPDATE credit_settings SET anthropic_warn_cents = ?1 WHERE id = 1",
                    [cents],
                )?;
            }
            if let Some(cents) = patch.fish_warn_cents {
                c.execute(
                    "UPDATE credit_settings SET fish_warn_cents = ?1 WHERE id = 1",
                    [cents],
                )?;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credit_ledger_defaults_and_patches() {
        let db = Db::in_memory().unwrap();
        let c = db.credits().unwrap();
        assert_eq!(c.anchor_cents, None);
        assert_eq!(c.anchored_at, None);
        assert_eq!((c.anthropic_warn_cents, c.fish_warn_cents), (1000, 200));

        db.set_credits(&CreditPatch {
            anchor_cents: Some(900),
            ..Default::default()
        })
        .unwrap();
        let c = db.credits().unwrap();
        assert_eq!(c.anchor_cents, Some(900));
        assert!(c.anchored_at.is_some_and(|t| (now() - t).abs() < 5));
        assert_eq!(c.anthropic_warn_cents, 1000, "untouched");

        db.set_credits(&CreditPatch {
            fish_warn_cents: Some(50),
            ..Default::default()
        })
        .unwrap();
        let c = db.credits().unwrap();
        assert_eq!((c.anchor_cents, c.fish_warn_cents), (Some(900), 50));
    }
}
