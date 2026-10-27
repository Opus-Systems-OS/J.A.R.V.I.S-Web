//! SQLite for what this site owns: unlocked browser sessions, failed unlock
//! attempts, the honeypot's trap hits and bans, the credit ledger — the Anthropic balance you typed after a
//! top-up and your warning thresholds — the reminders Jarvis sets, and when
//! you last opened the HUD, and the Intel watchlist. Fleet state, usage and everything
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
-- The honeypot (`honey.rs`). A ban lasts until it is lifted by hand.
CREATE TABLE IF NOT EXISTS bans (
  ip      TEXT PRIMARY KEY,
  at      INTEGER NOT NULL,
  reason  TEXT NOT NULL,
  path    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trap_hits (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ip      TEXT NOT NULL,
  at      INTEGER NOT NULL,
  path    TEXT NOT NULL,
  ua      TEXT NOT NULL,
  banned  INTEGER NOT NULL      -- 0 = logged only (an unlocked browser)
);
-- Intel watchlist (`watches.rs`): a word, a place and radius, or both.
CREATE TABLE IF NOT EXISTS watches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  profile     TEXT NOT NULL,
  term        TEXT,
  place       TEXT,
  lat         REAL,
  lon         REAL,
  radius_km   REAL,
  created_at  INTEGER NOT NULL
);
-- Jarvis projects (`projects.rs`): ones that live here, not on GitHub. The
-- session is the Jarvis conversation it was started in (its outputs).
CREATE TABLE IF NOT EXISTS projects (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  profile      TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  session_id   TEXT,
  created_at   INTEGER NOT NULL
);
-- Feed items already announced for a profile, so no two HUDs say one twice.
CREATE TABLE IF NOT EXISTS watch_alerts (
  profile  TEXT NOT NULL,
  item     TEXT NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (profile, item)
);
-- Notes and tasks captured without a time (`reminders.rs`).
CREATE TABLE IF NOT EXISTS notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  profile     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('note', 'task')),
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  closed_at   INTEGER             -- done, or no longer wanted
);
-- A profile's passkeys: the second step of its unlock once it has one.
CREATE TABLE IF NOT EXISTS passkeys (
  id          TEXT PRIMARY KEY,   -- the credential id, base64url
  profile     TEXT NOT NULL,
  public_key  BLOB NOT NULL,      -- SPKI DER, P-256
  label       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
-- The bait passphrase in the fake `.env`: made once, kept across restarts.
CREATE TABLE IF NOT EXISTS honey (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  canary  TEXT NOT NULL
);
"#;

/// Columns added after a table first shipped: an `ALTER` guarded by
/// `PRAGMA table_info`, idempotent, a no-op on a fresh database. Rows from
/// before profiles existed are Mr. Walker's.
const ADDED: &[(&str, &str, &str)] = &[
    ("web_sessions", "profile", "TEXT NOT NULL DEFAULT 'walker'"),
    // 0 = not seen since unlock; `created_at` stands in.
    ("web_sessions", "last_seen_at", "INTEGER NOT NULL DEFAULT 0"),
    ("reminders", "profile", "TEXT NOT NULL DEFAULT 'walker'"),
    // A recurring reminder: its rule (`daily`, `weekdays`, `weekly:1,3`,
    // `every:3`) and wall time (`07:00`). Its `due_at` moves on when spoken.
    ("reminders", "recur", "TEXT"),
    ("reminders", "wall", "TEXT"),
    ("reminders", "last_spoken_at", "INTEGER"),
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
    pub recur: Option<String>,
    pub wall: Option<String>,
}

/// A note or task still open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub id: i64,
    pub kind: String,
    pub text: String,
    pub created_at: i64,
}

/// One entry on a profile's Intel watchlist.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Watch {
    pub id: i64,
    pub term: Option<String>,
    pub place: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub radius_km: Option<f64>,
    pub created_at: i64,
}

/// A Jarvis project: one that lives here rather than on GitHub.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub session_id: Option<String>,
    pub created_at: i64,
}

/// How many trap hits are kept; older ones go as new ones arrive.
const TRAP_HITS_KEPT: i64 = 2000;

/// An address the honeypot shut out.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Ban {
    pub ip: String,
    pub at: i64,
    /// `trap`, `canary` or `honeyfield`.
    pub reason: String,
    pub path: String,
}

/// One request to a trap path.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TrapHit {
    pub ip: String,
    pub at: i64,
    pub path: String,
    pub ua: String,
    /// `false` when it came from an unlocked browser (logged, not banned).
    pub banned: bool,
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
                "INSERT INTO web_sessions (token_sha256, created_at, expires_at, ip, profile, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?2)",
                params![token_sha256, now, now + ttl_secs, ip, profile],
            )?;
            Ok(())
        })
    }

    /// The profile an unexpired session was unlocked as, provided it was
    /// seen within the last `idle_secs`. Seeing it again moves that window,
    /// written at most once a minute so a busy HUD isn't a write per request.
    pub fn session_profile(&self, token_sha256: &str, idle_secs: i64) -> Result<Option<String>> {
        let now = now();
        self.with(|c| {
            let found: Option<(String, i64)> = c
                .query_row(
                    "SELECT profile, MAX(last_seen_at, created_at) FROM web_sessions
                     WHERE token_sha256 = ?1 AND expires_at > ?2",
                    params![token_sha256, now],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let Some((profile, seen)) = found else {
                return Ok(None);
            };
            if seen <= now - idle_secs {
                c.execute(
                    "DELETE FROM web_sessions WHERE token_sha256 = ?1",
                    [token_sha256],
                )?;
                return Ok(None);
            }
            if seen <= now - 60 {
                c.execute(
                    "UPDATE web_sessions SET last_seen_at = ?2 WHERE token_sha256 = ?1",
                    params![token_sha256, now],
                )?;
            }
            Ok(Some(profile))
        })
    }

    /// Lock every browser unlocked as `profile`. Returns how many.
    pub fn delete_profile_sessions(&self, profile: &str) -> Result<usize> {
        self.with(|c| c.execute("DELETE FROM web_sessions WHERE profile = ?1", [profile]))
    }

    // ---- passkeys ------------------------------------------------------------

    pub fn add_passkey(
        &self,
        profile: &str,
        id: &str,
        public_key: &[u8],
        label: &str,
    ) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO passkeys (id, profile, public_key, label, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, profile, public_key, label, now()],
            )
            .map(|_| ())
        })
    }

    /// `(id, label, created_at)`, oldest first.
    pub fn passkeys(&self, profile: &str) -> Result<Vec<(String, String, i64)>> {
        self.with(|c| {
            c.prepare(
                "SELECT id, label, created_at FROM passkeys WHERE profile = ?1 ORDER BY created_at, id",
            )?
            .query_map([profile], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect()
        })
    }

    pub fn passkey_key(&self, profile: &str, id: &str) -> Result<Option<Vec<u8>>> {
        self.with(|c| {
            c.query_row(
                "SELECT public_key FROM passkeys WHERE profile = ?1 AND id = ?2",
                params![profile, id],
                |r| r.get(0),
            )
            .optional()
        })
    }

    pub fn remove_passkey(&self, profile: &str, id: &str) -> Result<bool> {
        self.with(|c| {
            c.execute(
                "DELETE FROM passkeys WHERE profile = ?1 AND id = ?2",
                params![profile, id],
            )
            .map(|n| n > 0)
        })
    }

    /// Every passkey of `profile`: the recovery for a lost device.
    pub fn clear_passkeys(&self, profile: &str) -> Result<usize> {
        self.with(|c| c.execute("DELETE FROM passkeys WHERE profile = ?1", [profile]))
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

    // ---- honeypot --------------------------------------------------------------

    /// The bait passphrase, made on first use.
    pub fn canary(&self) -> Result<String> {
        let fresh = crate::honey::new_canary();
        self.with(|c| {
            c.execute(
                "INSERT OR IGNORE INTO honey (id, canary) VALUES (1, ?1)",
                [&fresh],
            )?;
            c.query_row("SELECT canary FROM honey WHERE id = 1", [], |r| r.get(0))
        })
    }

    pub fn record_trap(&self, ip: &str, path: &str, ua: &str, banned: bool) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO trap_hits (ip, at, path, ua, banned) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![ip, now(), path, ua, banned],
            )?;
            c.execute(
                "DELETE FROM trap_hits WHERE id <= (SELECT MAX(id) FROM trap_hits) - ?1",
                [TRAP_HITS_KEPT],
            )
            .map(|_| ())
        })
    }

    /// Ban `ip`. The first reason sticks.
    pub fn ban(&self, ip: &str, reason: &str, path: &str) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT OR IGNORE INTO bans (ip, at, reason, path) VALUES (?1, ?2, ?3, ?4)",
                params![ip, now(), reason, path],
            )
            .map(|_| ())
        })
    }

    pub fn is_banned(&self, ip: &str) -> Result<bool> {
        self.with(|c| {
            c.query_row("SELECT 1 FROM bans WHERE ip = ?1", [ip], |_| Ok(()))
                .optional()
                .map(|r| r.is_some())
        })
    }

    /// Whether there was a ban to lift.
    pub fn unban(&self, ip: &str) -> Result<bool> {
        self.with(|c| {
            c.execute("DELETE FROM bans WHERE ip = ?1", [ip])
                .map(|n| n > 0)
        })
    }

    /// Every ban, newest first.
    pub fn bans(&self) -> Result<Vec<Ban>> {
        self.with(|c| {
            c.prepare("SELECT ip, at, reason, path FROM bans ORDER BY at DESC, ip")?
                .query_map([], |r| {
                    Ok(Ban {
                        ip: r.get(0)?,
                        at: r.get(1)?,
                        reason: r.get(2)?,
                        path: r.get(3)?,
                    })
                })?
                .collect()
        })
    }

    /// The latest `limit` trap hits, newest first.
    pub fn trap_hits(&self, limit: u32) -> Result<Vec<TrapHit>> {
        self.with(|c| {
            c.prepare("SELECT ip, at, path, ua, banned FROM trap_hits ORDER BY id DESC LIMIT ?1")?
                .query_map([limit], |r| {
                    Ok(TrapHit {
                        ip: r.get(0)?,
                        at: r.get(1)?,
                        path: r.get(2)?,
                        ua: r.get(3)?,
                        banned: r.get(4)?,
                    })
                })?
                .collect()
        })
    }

    // ---- reminders -------------------------------------------------------------

    /// `repeat` is a recurring reminder's rule and wall time.
    pub fn add_reminder(
        &self,
        profile: &str,
        text: &str,
        due_at: i64,
        repeat: Option<(&str, &str)>,
    ) -> Result<i64> {
        let now = now();
        self.with(|c| {
            // Spoken or cancelled more than 30 days ago: gone.
            c.execute(
                "DELETE FROM reminders WHERE COALESCE(delivered_at, cancelled_at) < ?1",
                [now - 30 * 86_400],
            )?;
            c.execute(
                "INSERT INTO reminders (text, due_at, created_at, profile, recur, wall)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    text,
                    due_at,
                    now,
                    profile,
                    repeat.map(|r| r.0),
                    repeat.map(|r| r.1)
                ],
            )?;
            Ok(c.last_insert_rowid())
        })
    }

    /// `profile`'s reminders not yet spoken and not cancelled, soonest first.
    pub fn pending_reminders(&self, profile: &str) -> Result<Vec<Reminder>> {
        self.with(|c| {
            c.prepare(
                "SELECT id, text, due_at, created_at, recur, wall FROM reminders
                 WHERE profile = ?1 AND delivered_at IS NULL AND cancelled_at IS NULL
                 ORDER BY due_at, id",
            )?
            .query_map([profile], |r| {
                Ok(Reminder {
                    id: r.get(0)?,
                    text: r.get(1)?,
                    due_at: r.get(2)?,
                    created_at: r.get(3)?,
                    recur: r.get(4)?,
                    wall: r.get(5)?,
                })
            })?
            .collect()
        })
    }

    /// Mark one of `profile`'s pending reminders spoken (`delivered`) or
    /// cancelled. `false` when they have no such pending reminder.
    pub fn close_reminder(&self, profile: &str, id: i64, delivered: bool) -> Result<bool> {
        let set = if delivered {
            "delivered_at = ?2, last_spoken_at = ?2"
        } else {
            "cancelled_at = ?2"
        };
        self.with(|c| {
            c.execute(
                &format!(
                    "UPDATE reminders SET {set}
                     WHERE id = ?1 AND profile = ?3 AND delivered_at IS NULL AND cancelled_at IS NULL"
                ),
                params![id, now(), profile],
            )
            .map(|n| n == 1)
        })
    }

    /// A pending recurring reminder was spoken: move it on to `next_due`.
    /// `false` when `profile` has no such reminder.
    pub fn advance_reminder(&self, profile: &str, id: i64, next_due: i64) -> Result<bool> {
        self.with(|c| {
            c.execute(
                "UPDATE reminders SET due_at = ?2, last_spoken_at = ?3
                 WHERE id = ?1 AND profile = ?4 AND recur IS NOT NULL
                   AND delivered_at IS NULL AND cancelled_at IS NULL",
                params![id, next_due, now(), profile],
            )
            .map(|n| n == 1)
        })
    }

    /// Whether `profile`'s reminder `id` recurs; `None` when there is none.
    pub fn reminder_recurs(&self, profile: &str, id: i64) -> Result<Option<bool>> {
        self.with(|c| {
            c.query_row(
                "SELECT recur IS NOT NULL FROM reminders WHERE id = ?1 AND profile = ?2",
                params![id, profile],
                |r| r.get(0),
            )
            .optional()
        })
    }

    /// The text to snooze: reminder `id`, or else the one spoken last.
    pub fn snooze_source(&self, profile: &str, id: Option<i64>) -> Result<Option<String>> {
        self.with(|c| {
            match id {
                Some(id) => c.query_row(
                    "SELECT text FROM reminders WHERE id = ?1 AND profile = ?2",
                    params![id, profile],
                    |r| r.get(0),
                ),
                None => c.query_row(
                    "SELECT text FROM reminders WHERE profile = ?1 AND last_spoken_at IS NOT NULL
                     ORDER BY last_spoken_at DESC, id DESC LIMIT 1",
                    [profile],
                    |r| r.get(0),
                ),
            }
            .optional()
        })
    }

    // ---- notes -----------------------------------------------------------------

    pub fn add_note(&self, profile: &str, kind: &str, text: &str) -> Result<i64> {
        let now = now();
        self.with(|c| {
            // Closed more than 30 days ago: gone.
            c.execute(
                "DELETE FROM notes WHERE closed_at < ?1",
                [now - 30 * 86_400],
            )?;
            c.execute(
                "INSERT INTO notes (profile, kind, text, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![profile, kind, text, now],
            )?;
            Ok(c.last_insert_rowid())
        })
    }

    /// `profile`'s open notes and tasks, oldest first.
    pub fn open_notes(&self, profile: &str) -> Result<Vec<Note>> {
        self.with(|c| {
            c.prepare(
                "SELECT id, kind, text, created_at FROM notes
                 WHERE profile = ?1 AND closed_at IS NULL ORDER BY id",
            )?
            .query_map([profile], |r| {
                Ok(Note {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    text: r.get(2)?,
                    created_at: r.get(3)?,
                })
            })?
            .collect()
        })
    }

    /// Done or deleted. `false` when `profile` has no such open note.
    pub fn close_note(&self, profile: &str, id: i64) -> Result<bool> {
        self.with(|c| {
            c.execute(
                "UPDATE notes SET closed_at = ?2 WHERE id = ?1 AND profile = ?3 AND closed_at IS NULL",
                params![id, now(), profile],
            )
            .map(|n| n == 1)
        })
    }

    // ---- Jarvis projects ---------------------------------------------------------

    pub fn projects(&self, profile: &str) -> Result<Vec<Project>> {
        self.with(|c| {
            c.prepare(
                "SELECT id, name, description, session_id, created_at FROM projects
                 WHERE profile = ?1 ORDER BY created_at DESC, id DESC",
            )?
            .query_map([profile], |r| {
                Ok(Project {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    description: r.get(2)?,
                    session_id: r.get(3)?,
                    created_at: r.get(4)?,
                })
            })?
            .collect()
        })
    }

    /// `None` when `profile` already has `max` projects.
    pub fn add_project(
        &self,
        profile: &str,
        name: &str,
        description: &str,
        session_id: Option<&str>,
        max: i64,
    ) -> Result<Option<Project>> {
        let now = now();
        self.with(|c| {
            let n: i64 = c.query_row(
                "SELECT COUNT(*) FROM projects WHERE profile = ?1",
                [profile],
                |r| r.get(0),
            )?;
            if n >= max {
                return Ok(None);
            }
            c.execute(
                "INSERT INTO projects (profile, name, description, session_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![profile, name, description, session_id, now],
            )?;
            Ok(Some(Project {
                id: c.last_insert_rowid(),
                name: name.to_owned(),
                description: description.to_owned(),
                session_id: session_id.map(str::to_owned),
                created_at: now,
            }))
        })
    }

    /// Tie `profile`'s project to a (new) conversation.
    pub fn set_project_session(&self, profile: &str, id: i64, session: &str) -> Result<bool> {
        self.with(|c| {
            c.execute(
                "UPDATE projects SET session_id = ?3 WHERE id = ?1 AND profile = ?2",
                params![id, profile, session],
            )
            .map(|n| n == 1)
        })
    }

    pub fn remove_project(&self, profile: &str, id: i64) -> Result<bool> {
        self.with(|c| {
            c.execute(
                "DELETE FROM projects WHERE id = ?1 AND profile = ?2",
                params![id, profile],
            )
            .map(|n| n == 1)
        })
    }

    // ---- watchlist ---------------------------------------------------------------

    pub fn watches(&self, profile: &str) -> Result<Vec<Watch>> {
        self.with(|c| {
            c.prepare(
                "SELECT id, term, place, lat, lon, radius_km, created_at FROM watches
                 WHERE profile = ?1 ORDER BY id",
            )?
            .query_map([profile], |r| {
                Ok(Watch {
                    id: r.get(0)?,
                    term: r.get(1)?,
                    place: r.get(2)?,
                    lat: r.get(3)?,
                    lon: r.get(4)?,
                    radius_km: r.get(5)?,
                    created_at: r.get(6)?,
                })
            })?
            .collect()
        })
    }

    /// `None` when `profile` already has `max` watches.
    pub fn add_watch(&self, profile: &str, w: &Watch, max: i64) -> Result<Option<i64>> {
        self.with(|c| {
            let n: i64 = c.query_row(
                "SELECT COUNT(*) FROM watches WHERE profile = ?1",
                [profile],
                |r| r.get(0),
            )?;
            if n >= max {
                return Ok(None);
            }
            c.execute(
                "INSERT INTO watches (profile, term, place, lat, lon, radius_km, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    profile,
                    w.term,
                    w.place,
                    w.lat,
                    w.lon,
                    w.radius_km,
                    w.created_at
                ],
            )?;
            Ok(Some(c.last_insert_rowid()))
        })
    }

    pub fn remove_watch(&self, profile: &str, id: i64) -> Result<bool> {
        self.with(|c| {
            c.execute(
                "DELETE FROM watches WHERE id = ?1 AND profile = ?2",
                params![id, profile],
            )
            .map(|n| n == 1)
        })
    }

    /// Record `items` as announced for `profile`; the ones that weren't yet.
    pub fn mark_alerted(&self, profile: &str, items: &[String]) -> Result<Vec<String>> {
        let now = now();
        self.with(|c| {
            // Feeds forget a story within days; so can we.
            c.execute(
                "DELETE FROM watch_alerts WHERE at < ?1",
                [now - 14 * 86_400],
            )?;
            let mut fresh = Vec::new();
            for item in items {
                if c.execute(
                    "INSERT OR IGNORE INTO watch_alerts (profile, item, at) VALUES (?1, ?2, ?3)",
                    params![profile, item, now],
                )? == 1
                {
                    fresh.push(item.clone());
                }
            }
            Ok(fresh)
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
    fn projects_are_per_profile_and_capped() {
        let db = Db::in_memory().unwrap();
        let p = db
            .add_project("walker", "Iron Suit", "Mk 2", Some("sesn_1"), 2)
            .unwrap()
            .unwrap();
        db.add_project("walker", "Two", "", None, 2)
            .unwrap()
            .unwrap();
        assert_eq!(
            db.add_project("walker", "Three", "", None, 2).unwrap(),
            None
        );
        assert!(db.projects("powers").unwrap().is_empty());
        assert!(!db.remove_project("powers", p.id).unwrap(), "not his");
        assert!(!db.set_project_session("powers", p.id, "sesn_2").unwrap());
        assert!(db.set_project_session("walker", p.id, "sesn_2").unwrap());
        assert_eq!(
            db.projects("walker").unwrap()[1].session_id.as_deref(),
            Some("sesn_2")
        );
        assert!(db.remove_project("walker", p.id).unwrap());
        assert_eq!(db.projects("walker").unwrap().len(), 1);
    }

    #[test]
    fn watches_are_per_profile_and_alerts_said_once() {
        let db = Db::in_memory().unwrap();
        let w = Watch {
            id: 0,
            term: Some("fire".into()),
            place: None,
            lat: None,
            lon: None,
            radius_km: None,
            created_at: now(),
        };
        let id = db.add_watch("walker", &w, 2).unwrap().unwrap();
        db.add_watch("walker", &w, 2).unwrap().unwrap();
        assert_eq!(db.add_watch("walker", &w, 2).unwrap(), None, "full");
        assert!(db.watches("powers").unwrap().is_empty());
        assert!(!db.remove_watch("powers", id).unwrap(), "not his");
        assert!(db.remove_watch("walker", id).unwrap());
        assert_eq!(db.watches("walker").unwrap().len(), 1);
        let ids = vec!["a".to_owned(), "b".to_owned()];
        assert_eq!(db.mark_alerted("walker", &ids).unwrap(), ids);
        assert!(db.mark_alerted("walker", &ids).unwrap().is_empty());
        assert_eq!(db.mark_alerted("powers", &ids).unwrap(), ids);
    }

    #[test]
    fn reminders_are_pending_until_spoken_or_cancelled() {
        let db = Db::in_memory().unwrap();
        let later = db
            .add_reminder("walker", "call Josh", now() + 3600, None)
            .unwrap();
        let sooner = db
            .add_reminder("walker", "stand up", now() + 60, None)
            .unwrap();
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
        let mine = db.add_reminder("walker", "mine", now() + 60, None).unwrap();
        let his = db.add_reminder("powers", "his", now() + 60, None).unwrap();
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
    fn a_recurring_reminder_moves_on_and_can_be_snoozed() {
        let db = Db::in_memory().unwrap();
        let once = db.add_reminder("walker", "once", now() + 60, None).unwrap();
        let daily = db
            .add_reminder("walker", "vitamins", now() + 60, Some(("daily", "08:00")))
            .unwrap();
        assert_eq!(db.reminder_recurs("walker", daily).unwrap(), Some(true));
        assert_eq!(db.reminder_recurs("walker", once).unwrap(), Some(false));
        assert_eq!(db.reminder_recurs("powers", daily).unwrap(), None);
        let next = now() + 86_400;
        assert!(
            !db.advance_reminder("walker", once, next).unwrap(),
            "one-offs close"
        );
        assert!(db.advance_reminder("walker", daily, next).unwrap());
        let p = db.pending_reminders("walker").unwrap();
        let d = p.iter().find(|r| r.id == daily).unwrap();
        assert_eq!(
            (d.due_at, d.recur.as_deref(), d.wall.as_deref()),
            (next, Some("daily"), Some("08:00"))
        );
        // Snooze takes the last one spoken, or the one named.
        assert_eq!(
            db.snooze_source("walker", None).unwrap().as_deref(),
            Some("vitamins")
        );
        assert_eq!(
            db.snooze_source("walker", Some(once)).unwrap().as_deref(),
            Some("once")
        );
        assert_eq!(db.snooze_source("powers", None).unwrap(), None);
        assert_eq!(db.snooze_source("powers", Some(once)).unwrap(), None);
    }

    #[test]
    fn notes_are_open_until_closed_and_per_profile() {
        let db = Db::in_memory().unwrap();
        let n = db.add_note("walker", "note", "XREAL firmware").unwrap();
        db.add_note("powers", "task", "his").unwrap();
        let open = db.open_notes("walker").unwrap();
        assert_eq!(
            (open.len(), open[0].kind.as_str(), open[0].text.as_str()),
            (1, "note", "XREAL firmware")
        );
        assert!(
            !db.close_note("powers", n).unwrap(),
            "nobody closes someone else's"
        );
        assert!(db.close_note("walker", n).unwrap());
        assert!(!db.close_note("walker", n).unwrap(), "already closed");
        assert!(db.open_notes("walker").unwrap().is_empty());
        assert!(
            db.add_note("walker", "memo", "x").is_err(),
            "kind is checked"
        );
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
        assert_eq!(
            db.session_profile("t", i64::MAX).unwrap().as_deref(),
            Some("walker")
        );
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

    #[test]
    fn an_idle_session_locks_and_a_used_one_does_not() {
        let db = Db::in_memory().unwrap();
        db.insert_session("fresh", 3600, "1.2.3.4", "walker")
            .unwrap();
        db.insert_session("stale", 3600, "1.2.3.4", "walker")
            .unwrap();
        db.with(|c| {
            c.execute(
                "UPDATE web_sessions SET created_at = ?1, last_seen_at = ?1 WHERE token_sha256 = 'stale'",
                [now() - 7300],
            )
        })
        .unwrap();
        assert_eq!(
            db.session_profile("fresh", 7200).unwrap().as_deref(),
            Some("walker")
        );
        assert_eq!(db.session_profile("stale", 7200).unwrap(), None);
        // …and it is gone, not just refused.
        assert_eq!(db.session_profile("stale", i64::MAX).unwrap(), None);
    }

    #[test]
    fn locking_every_device_is_per_profile() {
        let db = Db::in_memory().unwrap();
        db.insert_session("a", 3600, "1.2.3.4", "walker").unwrap();
        db.insert_session("b", 3600, "5.6.7.8", "walker").unwrap();
        db.insert_session("c", 3600, "5.6.7.8", "powers").unwrap();
        assert_eq!(db.delete_profile_sessions("walker").unwrap(), 2);
        assert_eq!(db.session_profile("a", 7200).unwrap(), None);
        assert_eq!(
            db.session_profile("c", 7200).unwrap().as_deref(),
            Some("powers")
        );
    }

    #[test]
    fn bans_last_until_lifted_and_the_canary_is_stable() {
        let db = Db::in_memory().unwrap();
        let canary = db.canary().unwrap();
        assert_eq!(db.canary().unwrap(), canary);
        assert!(!db.is_banned("9.9.9.9").unwrap());
        db.ban("9.9.9.9", "trap", "/.env").unwrap();
        db.ban("9.9.9.9", "canary", "/auth/login").unwrap();
        assert!(db.is_banned("9.9.9.9").unwrap());
        assert_eq!(db.bans().unwrap()[0].reason, "trap");
        assert!(db.unban("9.9.9.9").unwrap());
        assert!(!db.unban("9.9.9.9").unwrap());
        assert!(!db.is_banned("9.9.9.9").unwrap());
    }

    #[test]
    fn trap_hits_are_capped() {
        let db = Db::in_memory().unwrap();
        for i in 0..(TRAP_HITS_KEPT + 5) {
            db.record_trap("9.9.9.9", &format!("/t{i}"), "curl", true)
                .unwrap();
        }
        let n: i64 = db
            .with(|c| c.query_row("SELECT COUNT(*) FROM trap_hits", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(n, TRAP_HITS_KEPT);
        assert_eq!(
            db.trap_hits(1).unwrap()[0].path,
            format!("/t{}", TRAP_HITS_KEPT + 4)
        );
    }
}
