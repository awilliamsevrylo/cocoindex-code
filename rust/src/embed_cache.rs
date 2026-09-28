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
//! 4. **`open` degrades too.** A cache file SQLite cannot read (code 26, "file
//!    is not a database") used to return `Err` and kill the index at
//!    construction. It is now moved aside as `<name>.corrupt-<epoch>` and
//!    rebuilt; if even that fails, `open` succeeds with a **cache-less** cache —
//!    every `get_many` a miss, every `put_many` a no-op — and one `warn!`.
//! 5. **A row is checked against its own recorded shape.** Each row carries the
//!    dimension it was written with, so a truncated or corrupt blob is a miss
//!    rather than a silently-shortened hit. (Rows written before the shape
//!    column existed carry `0` = unknown; they are accepted if their length is
//!    a whole number of f32s.)

use std::path::Path;

use anyhow::Result;
use sha2::{Digest, Sha256};
use sqlx::{Acquire, Row};

use crate::embedder_params::Params;

#[path = "embed_cache_repair.rs"]
mod repair;
use repair::{Inner, open_inner};

pub type Key = [u8; 32];

/// SQLite caps bound parameters per statement; stay well under it.
const LOOKUP_CHUNK: usize = 500;

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

/// `None` when the blob is not a vector of `recorded` dims (`recorded == 0` =
/// unknown shape, i.e. a row written before the cache recorded dimensions).
/// A short blob must not silently become a hit of the wrong length.
fn decode(b: &[u8], recorded: i64) -> Option<Vec<f32>> {
    if b.is_empty() || b.len() % 4 != 0 {
        return None;
    }
    let dims = b.len() / 4;
    if recorded > 0 && recorded as usize != dims {
        return None;
    }
    Some(
        b.chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}

/// A cache handle. `None` inside means the cache is unusable and the handle is
/// deliberately inert: all misses, no writes, no errors.
#[derive(Clone)]
pub struct EmbedCache {
    inner: Option<Inner>,
}

impl EmbedCache {
    /// Never fails for an unusable *cache*: a file SQLite cannot read is moved
    /// aside and rebuilt, and a cache that cannot be rebuilt at all degrades to
    /// an inert one. See the module docs, point 4.
    pub async fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        Ok(Self { inner: open_inner(path).await })
    }

    /// Test seam: close the single writer pool, so the next `put_many`'s
    /// `acquire()` fails *now* instead of after the real 300s cap. That cap is
    /// reachable in production (~150 concurrent callers against a wedged
    /// writer) and is the only way `put_many` can still return `Err`; the
    /// call site must survive it. No double: the pool is the real one.
    #[cfg(test)]
    pub(crate) async fn close_writer_for_test(&self) {
        if let Some(inner) = &self.inner {
            inner.write.close().await;
        }
    }

    /// One slot per key, `None` on a miss. An unreadable cache is all misses:
    /// the caller then pays for a fetch it would have paid for anyway.
    pub async fn get_many(&self, keys: &[Key]) -> Result<Vec<Option<Vec<f32>>>> {
        let Some(inner) = &self.inner else {
            return Ok(keys.iter().map(|_| None).collect());
        };
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let mut found = std::collections::HashMap::new();
        for chunk in keys.chunks(LOOKUP_CHUNK) {
            let marks = vec!["?"; chunk.len()].join(",");
            let sql = format!("SELECT k, v, d FROM vectors WHERE k IN ({marks})");
            let mut q = sqlx::query(&sql);
            for k in chunk {
                q = q.bind(k.as_slice());
            }
            let rows = match q.fetch_all(&inner.pool).await {
                Ok(rows) => rows,
                Err(err) => {
                    tracing::warn!("embed cache read failed, treating as a miss: {err:#}");
                    return Ok(keys.iter().map(|_| None).collect());
                }
            };
            for row in rows {
                let k: Vec<u8> = row.get(0);
                let v: Vec<u8> = row.get(1);
                let d: i64 = row.get(2);
                match decode(&v, d) {
                    Some(vec) => {
                        found.insert(k, vec);
                    }
                    None => tracing::warn!(
                        "embed cache row skipped: {} bytes is not a {d}-dim vector; treating as a miss",
                        v.len()
                    ),
                }
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
        let Some(inner) = &self.inner else {
            return Ok(());
        };
        if items.is_empty() {
            return Ok(());
        }
        let mut conn = match inner.write.acquire().await {
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
            let write = sqlx::query("INSERT OR REPLACE INTO vectors (k, v, d) VALUES (?, ?, ?)")
                .bind(k.as_slice())
                .bind(encode(v))
                .bind(v.len() as i64)
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