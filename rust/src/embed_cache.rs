//! Content-addressed vector cache — the resume ledger for remote embeddings.
//!
//! key = sha256("v1", model, params, text) → little-endian f32 vector. Written
//! as soon as a batch comes back, so a crash, a `cccrust reset`, or the same
//! chunk appearing in another file never pays Voyage twice. Correct by
//! construction: a different model, `input_type`, or text is a different key.
//!
//! ## The cache must never fail the index that owns it
//!
//! Measured 2026-09-28: `cccrust index` over 71k files in ~/PROJECTS/aosp-docs
//! died with "embed: pool timed out while waiting for an open connection" while
//! a second process held a write transaction on the shared `embed_cache.db`.
//! The cache is an optimisation over a paid API; every path here therefore
//! treats an unusable cache as a *miss*, never an abort:
//!
//! 1. **Reads and writes never share a connection pool.** A caller blocked
//!    inside SQLite's `busy_timeout` holds its connection for that whole wait;
//!    with one pool, blocked writers starve every reader (that was the bug).
//! 2. **Writes are serialized through a single-connection pool.** SQLite is a
//!    single-writer engine anyway, so one writer connection turns cross-task
//!    contention into a queue instead of a pile of `SQLITE_BUSY`.
//! 3. **Every operational error degrades** — a read error is reported as a miss,
//!    a write error is logged and dropped — with `tracing::warn!`, so a
//!    persistently broken cache is visible without being fatal.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};
use sqlx::{Acquire, Row};

use crate::embedder_params::Params;

pub type Key = [u8; 32];

/// SQLite caps bound parameters per statement; stay well under it.
const LOOKUP_CHUNK: usize = 500;

/// Concurrent readers. Only reached with that many callers genuinely in flight.
const READERS: u32 = 8;
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

const SCHEMA: &str =
    "CREATE TABLE IF NOT EXISTS vectors (k BLOB PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID";

pub fn cache_key(model: &str, params: &Params, text: &str) -> Key {
    let mut h = Sha256::new();
    // serde_json::Map is a BTreeMap here, so params serialize in key order.
    let params = serde_json::to_string(params).unwrap_or_default();
    for part in ["v1", model, &params, text] {
        h.update((part.len() as u64).to_le_bytes()); // length-prefixed: no ambiguity
        h.update(part.as_bytes());
    }
    h.finalize().into()
}

fn encode(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn decode(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
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

#[derive(Clone)]
pub struct EmbedCache {
    /// Reads only.
    pool: SqlitePool,
    /// The single writer.
    write: SqlitePool,
}

impl EmbedCache {
    pub async fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let writer = SqlitePoolOptions::new()
            .max_connections(WRITERS)
            .acquire_timeout(ACQUIRE_TIMEOUT)
            .connect_with(writer_options(path))
            .await
            .with_context(|| format!("opening embed cache {}", path.display()))?;
        sqlx::query(SCHEMA).execute(&writer).await?;
        let pool = SqlitePoolOptions::new()
            .max_connections(READERS)
            .acquire_timeout(ACQUIRE_TIMEOUT)
            .connect_with(reader_options(path))
            .await
            .with_context(|| format!("opening embed cache {}", path.display()))?;
        Ok(Self {
            pool,
            write: writer,
        })
    }

    /// One slot per key, `None` on a miss. An unreadable cache is all misses:
    /// the caller then pays for a fetch it would have paid for anyway.
    pub async fn get_many(&self, keys: &[Key]) -> Result<Vec<Option<Vec<f32>>>> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let mut found = std::collections::HashMap::new();
        for chunk in keys.chunks(LOOKUP_CHUNK) {
            let marks = vec!["?"; chunk.len()].join(",");
            let sql = format!("SELECT k, v FROM vectors WHERE k IN ({marks})");
            let mut q = sqlx::query(&sql);
            for k in chunk {
                q = q.bind(k.as_slice());
            }
            let rows = match q.fetch_all(&self.pool).await {
                Ok(rows) => rows,
                Err(err) => {
                    tracing::warn!("embed cache read failed, treating as a miss: {err:#}");
                    return Ok(keys.iter().map(|_| None).collect());
                }
            };
            for row in rows {
                let k: Vec<u8> = row.get(0);
                let v: Vec<u8> = row.get(1);
                found.insert(k, decode(&v));
            }
        }
        Ok(keys
            .iter()
            .map(|k| found.get(k.as_slice()).cloned())
            .collect())
    }

    /// Best effort by contract: a write that cannot be made is logged and
    /// dropped, so a contended or wedged cache never aborts an index run.
    pub async fn put_many(&self, items: &[(Key, &[f32])]) -> Result<()> {
        if items.is_empty() {
            return Ok(());
        }
        let mut conn = match self.write.acquire().await {
            Ok(conn) => conn,
            Err(err) => {
                tracing::warn!("embed cache write skipped (no writer connection): {err:#}");
                return Ok(());
            }
        };
        let mut tx = match conn.begin().await {
            Ok(tx) => tx,
            Err(err) => {
                tracing::warn!("embed cache write skipped (no transaction): {err:#}");
                return Ok(());
            }
        };
        for (k, v) in items {
            let write = sqlx::query("INSERT OR REPLACE INTO vectors (k, v) VALUES (?, ?)")
                .bind(k.as_slice())
                .bind(encode(v))
                .execute(&mut *tx)
                .await;
            if let Err(err) = write {
                tracing::warn!("embed cache write skipped: {err:#}");
                return Ok(());
            }
        }
        if let Err(err) = tx.commit().await {
            tracing::warn!("embed cache commit skipped: {err:#}");
        }
        Ok(())
    }
}
