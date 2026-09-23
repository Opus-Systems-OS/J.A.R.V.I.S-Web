//! SQLite for what this site owns: unlocked browser sessions and failed
//! unlock attempts. Fleet state, usage and everything Jarvis knows are read
//! live through the API — never stored here. Times are unix seconds.

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
"#;

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
}
