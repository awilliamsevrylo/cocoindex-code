//! Opening the cache file — and repairing it when it cannot be read.
//!
//! Split out of `embed_cache.rs` because it is a different job: that module
//! decides what a good row means, this one decides what to do with a *bad file*.
//! The policy is the module-level contract there (point 4): an unreadable cache
//! is moved aside and rebuilt, and a cache that cannot be rebuilt degrades to
//! an inert one rather than aborting the index that owns it.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};

/// Concurrent readers. Only reached with that many callers genuinely in flight.
pub(super) const READERS: u32 = 8;
/// SQLite serializes writers; one connection makes that explicit.
const WRITERS: u32 = 1;
/// Generation of a pooled connection. Well above sqlx's 30s default: under a
/// 1.8 GB cache and a concurrent index, 30s is a realistic wait, and the old
/// default turned a slow cache into a dead index.
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(300);
/// Reads wait only on a checkpoint, so a short wait is enough.
const READ_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
/// A write that cannot take the lock within a couple of seconds is dropped: the
/// vector stays a cache miss and is simply re-fetched next run. Two seconds is
/// ample for the other cccrust process to finish its (millisecond) transaction,
/// and it bounds what a *wedged* one can cost — the write path returns on the
/// first failed statement, so this is the worst case per put, not per row.
const WRITE_BUSY_TIMEOUT: Duration = Duration::from_secs(2);

/// `d` is the dimension the row was written with, `0` when unknown (a row from
/// a cache predating this column).
const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS vectors (\
     k BLOB PRIMARY KEY, v BLOB NOT NULL, d INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID";

/// Additive migration for caches written before `d` existed. Idempotent: the
/// "duplicate column name" error on an already-migrated table is expected.
const MIGRATE_SHAPE: &str = "ALTER TABLE vectors ADD COLUMN d INTEGER NOT NULL DEFAULT 0";

/// The live pools behind an opened cache. Its absence is the degraded state.
#[derive(Clone)]
pub(super) struct Inner {
    /// Reads only.
    pub(super) pool: SqlitePool,
    /// The single writer.
    pub(super) write: SqlitePool,
}

fn reader_options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(READ_BUSY_TIMEOUT)
}

fn writer_options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(WRITE_BUSY_TIMEOUT)
}

/// `<name>.corrupt-<epoch>`, e.g. `embed_cache.db.corrupt-1759067...`.
fn quarantine_name(path: &Path) -> PathBuf {
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    PathBuf::from(format!("{}.corrupt-{epoch}", path.display()))
}

/// Open `path`, escalating on a bad file: quarantine and rebuild, else inert.
/// `None` means "run cache-less" — every get a miss, every put a no-op.
pub(super) async fn open_inner(path: &Path) -> Option<Inner> {
    match try_open(path).await {
        Ok(inner) => Some(inner),
        Err(err) => {
            tracing::warn!(
                "embed cache {} is unusable ({err:#}); quarantining it and starting fresh",
                path.display()
            );
            let aside = quarantine_name(path);
            if let Err(err) = std::fs::rename(path, &aside) {
                tracing::warn!(
                    "could not move the bad cache aside ({err:#}); running cache-less: \
                     every get is a miss, every put is a no-op"
                );
                return None;
            }
            // Stale WAL/SHM sidecars describe the file we just moved away.
            for sidecar in [format!("{}-wal", path.display()), format!("{}-shm", path.display())] {
                let _ = std::fs::remove_file(sidecar);
            }
            match try_open(path).await {
                Ok(inner) => {
                    tracing::warn!(
                        "embed cache rebuilt at {} (unreadable file kept at {})",
                        path.display(),
                        aside.display()
                    );
                    Some(inner)
                }
                Err(err) => {
                    tracing::warn!(
                        "embed cache could not be rebuilt ({err:#}); running cache-less: \
                         every get is a miss, every put is a no-op"
                    );
                    None
                }
            }
        }
    }
}

async fn try_open(path: &Path) -> Result<Inner> {
    let write = SqlitePoolOptions::new()
        .max_connections(WRITERS)
        .acquire_timeout(ACQUIRE_TIMEOUT)
        .connect_with(writer_options(path))
        .await
        .with_context(|| format!("opening embed cache {}", path.display()))?;
    sqlx::query(SCHEMA).execute(&write).await?;
    // Expected to fail on an already-migrated table; `SCHEMA` covers a fresh one.
    let _ = sqlx::query(MIGRATE_SHAPE).execute(&write).await;
    let pool = SqlitePoolOptions::new()
        .max_connections(READERS)
        .acquire_timeout(ACQUIRE_TIMEOUT)
        .connect_with(reader_options(path))
        .await
        .with_context(|| format!("opening embed cache {}", path.display()))?;
    Ok(Inner { pool, write })
}