//! Per-index embedding model. A project's `settings.yml` may pin its own
//! `embedding:` (provider/model/params); absent keys inherit the global
//! settings. Each index db records which model built it (`ccc_index_meta`),
//! so a search never embeds a query with a different model than the index.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use tokio::sync::Mutex;

use crate::embedder::{CodeEmbedder, create_embedder};
use crate::embedder_params::{Params, lookup_defaults, resolve_embedder_params};
use crate::settings::EmbeddingSettings;

const META_TABLE: &str = "ccc_index_meta";

/// The optional `embedding:` block in a project's settings.yml.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ProjectEmbedding {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indexing_params: Option<Params>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query_params: Option<Params>,
}

/// Merge a project override onto the global settings. Params: explicit
/// override > global (same provider+model) > curated table > none.
pub fn effective_embedding(global: &EmbeddingSettings, ov: &ProjectEmbedding) -> EmbeddingSettings {
    let provider = ov.provider.clone().unwrap_or_else(|| global.provider.clone());
    let model = ov.model.clone().unwrap_or_else(|| global.model.clone());
    let same = provider == global.provider && model == global.model;
    let curated = lookup_defaults(&provider, &model);
    let pick = |explicit: &Option<Params>, global_side: &Option<Option<Params>>, cur: Option<Params>| {
        if let Some(p) = explicit {
            return Some(Some(p.clone()));
        }
        if same {
            return global_side.clone();
        }
        cur.filter(|p| !p.is_empty()).map(Some)
    };
    EmbeddingSettings {
        indexing_params: pick(&ov.indexing_params, &global.indexing_params, curated.clone().map(|c| c.0)),
        query_params: pick(&ov.query_params, &global.query_params, curated.map(|c| c.1)),
        provider,
        model,
        device: global.device.clone(),
        min_interval_ms: global.min_interval_ms,
    }
}

/// Embedders shared across projects that resolve to the same settings, so a
/// local model is loaded once per daemon, not once per project.
#[derive(Default)]
pub struct EmbedderCache {
    by_key: Mutex<HashMap<String, (CodeEmbedder, Params)>>,
}

impl EmbedderCache {
    /// Register an already-built embedder (the daemon's global one).
    pub async fn seed(&self, settings: &EmbeddingSettings, embedder: CodeEmbedder, query: Params) {
        if let Ok(key) = serde_json::to_string(settings) {
            self.by_key.lock().await.insert(key, (embedder, query));
        }
    }

    /// Resolve (embedder, query params) for `settings`, building at most once.
    pub async fn get(&self, settings: &EmbeddingSettings) -> Result<(CodeEmbedder, Params)> {
        let key = serde_json::to_string(settings)?;
        let mut map = self.by_key.lock().await;
        if let Some(hit) = map.get(&key) {
            return Ok(hit.clone());
        }
        let params = resolve_embedder_params(settings)?;
        let embedder = create_embedder(settings, &params.indexing).await?;
        map.insert(key, (embedder.clone(), params.query.clone()));
        Ok((embedder, params.query))
    }
}

/// What built an index: the embedder identity and the vector width.
#[derive(Clone, Debug, PartialEq)]
pub struct IndexMeta {
    pub model: String,
    pub dims: usize,
}

pub async fn write_meta(db_path: &Path, meta: &IndexMeta) -> Result<()> {
    let pool = crate::db::open_pool(db_path).await?;
    sqlx::query(&format!("CREATE TABLE IF NOT EXISTS {META_TABLE} (k TEXT PRIMARY KEY, v TEXT NOT NULL)"))
        .execute(&pool)
        .await?;
    for (k, v) in [("model", meta.model.clone()), ("dims", meta.dims.to_string())] {
        sqlx::query(&format!("INSERT OR REPLACE INTO {META_TABLE} (k, v) VALUES (?, ?)"))
            .bind(k)
            .bind(v)
            .execute(&pool)
            .await?;
    }
    pool.close().await;
    Ok(())
}

/// `Ok(None)` only when the table is genuinely absent (an index built before
/// this existed); any other read failure is an error, not "no meta".
pub async fn read_meta(pool: &SqlitePool) -> Result<Option<IndexMeta>> {
    let has: i64 = sqlx::query("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?")
        .bind(META_TABLE)
        .fetch_one(pool)
        .await?
        .get(0);
    if has == 0 {
        return Ok(None);
    }
    let rows = sqlx::query(&format!("SELECT k, v FROM {META_TABLE}")).fetch_all(pool).await?;
    let get = |name: &str| rows.iter().find(|r| r.get::<String, _>(0) == name).map(|r| r.get::<String, _>(1));
    match (get("model"), get("dims")) {
        (Some(model), Some(dims)) => Ok(Some(IndexMeta { model, dims: dims.parse()? })),
        _ => bail!("{META_TABLE} is incomplete; run `cccrust reset -f` then `cccrust index`"),
    }
}

/// Refuse to search an index with a different model than the one that built
/// it. A legacy index (no meta) is allowed; the next `cccrust index` stamps it.
pub fn check_compatible(meta: Option<&IndexMeta>, configured: &str) -> Result<()> {
    if let Some(m) = meta {
        if m.model != configured {
            bail!(
                "This index was built with {} ({} dims) but the project is now configured for {}. \
                 Run `cccrust index` to rebuild it with the new model.",
                m.model,
                m.dims,
                configured
            );
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "index_model_tests.rs"]
mod tests;
