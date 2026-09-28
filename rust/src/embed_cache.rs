//! Content-addressed vector cache — the resume ledger for remote embeddings.
//!
//! key = sha256("v1", model, params, text) → little-endian f32 vector. Written
//! as soon as a batch comes back, so a crash, a `cccrust reset`, or the same
//! chunk appearing in another file never pays Voyage twice. Correct by
//! construction: a different model, `input_type`, or text is a different key.

use std::path::Path;

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions};
use sqlx::Row;

use crate::embedder_params::Params;

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

fn decode(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

#[derive(Clone)]
pub struct EmbedCache {
    pool: SqlitePool,
}

impl EmbedCache {
    pub async fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let opts = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(std::time::Duration::from_secs(30));
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(opts)
            .await
            .with_context(|| format!("opening embed cache {}", path.display()))?;
        sqlx::query("CREATE TABLE IF NOT EXISTS vectors (k BLOB PRIMARY KEY, v BLOB NOT NULL) WITHOUT ROWID")
            .execute(&pool)
            .await?;
        Ok(Self { pool })
    }

    /// One slot per key, `None` on a miss.
    pub async fn get_many(&self, keys: &[Key]) -> Result<Vec<Option<Vec<f32>>>> {
        let mut found = std::collections::HashMap::new();
        for chunk in keys.chunks(LOOKUP_CHUNK) {
            let marks = vec!["?"; chunk.len()].join(",");
            let sql = format!("SELECT k, v FROM vectors WHERE k IN ({marks})");
            let mut q = sqlx::query(&sql);
            for k in chunk {
                q = q.bind(k.as_slice());
            }
            for row in q.fetch_all(&self.pool).await? {
                let k: Vec<u8> = row.get(0);
                let v: Vec<u8> = row.get(1);
                found.insert(k, decode(&v));
            }
        }
        Ok(keys.iter().map(|k| found.get(k.as_slice()).cloned()).collect())
    }

    pub async fn put_many(&self, items: &[(Key, &[f32])]) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        for (k, v) in items {
            sqlx::query("INSERT OR REPLACE INTO vectors (k, v) VALUES (?, ?)")
                .bind(k.as_slice())
                .bind(encode(v))
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }
}
