//! SQLite for what this site owns: unlocked browser sessions, failed unlock
//! attempts, the credit ledger — the Anthropic balance you typed after a
//! top-up and your warning thresholds — the reminders Jarvis sets, and when
//! you last opened the HUD. Fleet state, usage and everything
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
CREATE TABLE IF NOT EXISTS reminders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  text          TEXT NOT NULL,
  due_at        INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  delivered_at  INTEGER,             -- spoken by a HUD
  cancelled_at  INTEGER
);
CREATE TABLE IF NOT EXISTS visits (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  last_at  INTEGER NOT NULL
);
-- One row per profile; replaces `visits` (Mr. Walker's row is carried over).
CREATE TABLE IF NOT EXISTS profile_visits (
  profile  TEXT PRIMARY KEY,
  last_at  INTEGER NOT NULL
);
"#;

/// Columns added after a table first shipped: an `ALTER` guarded by
/// `PRAGMA table_info`, idempotent, a no-op on a fresh database. Rows from
/// before profiles existed are Mr. Walker's.
const ADDED: &[(&str, &str, &str)] = &[
    ("web_sessions", "profile", "TEXT NOT NULL DEFAULT 'walker'"),
    ("reminders", "profile", "TEXT NOT NULL DEFAULT 'walker'"),
];

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    for (table, column, ty) in ADDED {
        let present = conn
            .prepare(&format!("PRAGMA table_info({table})"))?
            .query_map([], |r| r.get::<_, String>(1))?
            .any(|name| name.as_deref() == Ok(column));
        if !present {
            conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {ty}"))?;
        }
    }
    conn.execute(
        "INSERT OR IGNORE INTO profile_visits (profile, last_at)
         SELECT 'walker', last_at FROM visits WHERE id = 1",
        [],
    )?;
    Ok(())
}

/// A reminder that is still to be spoken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reminder {
    pub id: i64,
    pub text: String,
    pub due_at: i64,
    pub created_at: i64,
}

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
        migrate(&conn)?;
        Ok(Db {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        Ok(f(&conn)?)
    }

    // ---- sessions ------------------------------------------------------------

    pub fn insert_session(
        &self,
        token_sha256: &str,
        ttl_secs: i64,
        ip: &str,
        profile: &str,
    ) -> Result<()> {
        let now = now();
        self.with(|c| {
            // Expired rows go whenever a new one arrives; there are few.
            c.execute("DELETE FROM web_sessions WHERE expires_at <= ?1", [now])?;
            c.execute(
                "INSERT INTO web_sessions (token_sha256, created_at, expires_at, ip, profile)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![token_sha256, now, now + ttl_secs, ip, profile],
            )?;
            Ok(())
        })
    }

    /// The profile an unexpired session was unlocked as.
    pub fn session_profile(&self, token_sha256: &str) -> Result<Option<String>> {
        self.with(|c| {
            c.query_row(
                "SELECT profile FROM web_sessions WHERE token_sha256 = ?1 AND expires_at > ?2",
                params![token_sha256, now()],
                |r| r.get(0),
            )
            .optional()
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

    // ---- reminders -------------------------------------------------------------

    pub fn add_reminder(&self, profile: &str, text: &str, due_at: i64) -> Result<i64> {
        let now = now();
        self.with(|c| {
            // Spoken or cancelled more than 30 days ago: gone.
            c.execute(
                "DELETE FROM reminders WHERE COALESCE(delivered_at, cancelled_at) < ?1",
                [now - 30 * 86_400],
            )?;
            c.execute(
                "INSERT INTO reminders (text, due_at, created_at, profile) VALUES (?1, ?2, ?3, ?4)",
                params![text, due_at, now, profile],
            )?;
            Ok(c.last_insert_rowid())
        })
    }

    /// `profile`'s reminders not yet spoken and not cancelled, soonest first.
    pub fn pending_reminders(&self, profile: &str) -> Result<Vec<Reminder>> {
        self.with(|c| {
            c.prepare(
                "SELECT id, text, due_at, created_at FROM reminders
                 WHERE profile = ?1 AND delivered_at IS NULL AND cancelled_at IS NULL
                 ORDER BY due_at, id",
            )?
            .query_map([profile], |r| {
                Ok(Reminder {
                    id: r.get(0)?,
                    text: r.get(1)?,
                    due_at: r.get(2)?,
                    created_at: r.get(3)?,
                })
            })?
            .collect()
        })
    }

    /// Mark one of `profile`'s pending reminders spoken (`delivered`) or
    /// cancelled. `false` when they have no such pending reminder.
    pub fn close_reminder(&self, profile: &str, id: i64, delivered: bool) -> Result<bool> {
        let col = if delivered {
            "delivered_at"
        } else {
            "cancelled_at"
        };
        self.with(|c| {
            c.execute(
                &format!(
                    "UPDATE reminders SET {col} = ?2
                     WHERE id = ?1 AND profile = ?3 AND delivered_at IS NULL AND cancelled_at IS NULL"
                ),
                params![id, now(), profile],
            )
            .map(|n| n == 1)
        })
    }

    // ---- visits ----------------------------------------------------------------

    /// When `profile` last opened the HUD (unix seconds), and now is the new
    /// last.
    pub fn visit(&self, profile: &str) -> Result<Option<i64>> {
        let now = now();
        self.with(|c| {
            let prev: Option<i64> = c
                .query_row(
                    "SELECT last_at FROM profile_visits WHERE profile = ?1",
                    [profile],
                    |r| r.get(0),
                )
                .optional()?;
            c.execute(
                "INSERT INTO profile_visits (profile, last_at) VALUES (?1, ?2)
                 ON CONFLICT(profile) DO UPDATE SET last_at = excluded.last_at",
                params![profile, now],
            )?;
            Ok(prev)
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
    fn reminders_are_pending_until_spoken_or_cancelled() {
        let db = Db::in_memory().unwrap();
        let later = db
            .add_reminder("walker", "call Josh", now() + 3600)
            .unwrap();
        let sooner = db.add_reminder("walker", "stand up", now() + 60).unwrap();
        let p = db.pending_reminders("walker").unwrap();
        assert_eq!(
            p.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec![sooner, later]
        );
        assert!(db.close_reminder("walker", sooner, true).unwrap());
        assert!(
            !db.close_reminder("walker", sooner, false).unwrap(),
            "already spoken"
        );
        assert!(db.close_reminder("walker", later, false).unwrap());
        assert!(db.pending_reminders("walker").unwrap().is_empty());
        assert!(!db.close_reminder("walker", 999, true).unwrap());
    }

    #[test]
    fn reminders_belong_to_their_profile() {
        let db = Db::in_memory().unwrap();
        let mine = db.add_reminder("walker", "mine", now() + 60).unwrap();
        let his = db.add_reminder("powers", "his", now() + 60).unwrap();
        let texts = |p: &str| {
            db.pending_reminders(p)
                .unwrap()
                .into_iter()
                .map(|r| r.text)
                .collect::<Vec<_>>()
        };
        assert_eq!(texts("walker"), ["mine"]);
        assert_eq!(texts("powers"), ["his"]);
        assert!(
            !db.close_reminder("powers", mine, true).unwrap(),
            "nobody closes someone else's"
        );
        assert!(db.close_reminder("powers", his, true).unwrap());
        assert_eq!(texts("walker"), ["mine"]);
    }

    #[test]
    fn a_visit_returns_the_previous_one_per_profile() {
        let db = Db::in_memory().unwrap();
        assert_eq!(db.visit("walker").unwrap(), None);
        let first = db.visit("walker").unwrap().unwrap();
        assert!((now() - first).abs() < 5);
        assert_eq!(db.visit("powers").unwrap(), None, "his own first visit");
    }

    #[test]
    fn a_database_from_before_profiles_is_mr_walkers() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE web_sessions (token_sha256 TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
               expires_at INTEGER NOT NULL, ip TEXT NOT NULL);
             INSERT INTO web_sessions VALUES ('t', 0, 9999999999, '1.2.3.4');
             CREATE TABLE reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,
               due_at INTEGER NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER,
               cancelled_at INTEGER);
             INSERT INTO reminders (text, due_at, created_at) VALUES ('old', 1, 0);
             CREATE TABLE visits (id INTEGER PRIMARY KEY CHECK (id = 1), last_at INTEGER NOT NULL);
             INSERT INTO visits VALUES (1, 1234);",
        )
        .unwrap();
        let db = Db::init(conn).unwrap();
        assert_eq!(db.session_profile("t").unwrap().as_deref(), Some("walker"));
        assert_eq!(db.pending_reminders("walker").unwrap().len(), 1);
        assert!(db.pending_reminders("powers").unwrap().is_empty());
        assert_eq!(db.visit("walker").unwrap(), Some(1234));
        // And it survives being opened again.
        let conn = db.conn.lock().unwrap();
        migrate(&conn).unwrap();
    }

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
