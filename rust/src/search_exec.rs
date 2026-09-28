//! Search execution: orchestrates primary and dual search pipelines.

#[cfg(test)]
#[path = "search_exec_tests.rs"]
mod tests;

use std::path::Path;
use std::time::Duration;

use anyhow::{Result, bail};

use crate::dual_search::{DualSearchConfig, RerankStatus, dual_search};
use crate::embedder::CodeEmbedder;
use crate::embedder_params::Params;
use crate::protocol::SearchResult;
use crate::rerank::Reranker;
use crate::settings::target_sqlite_db_path;

/// Output of a search execution.
#[derive(Debug, Clone)]
pub struct SearchExecution {
    pub results: Vec<SearchResult>,
    pub rerank_status: Option<String>,
    pub primary_only: Option<bool>,
}

/// Map request pagination and rerank flags to a DualSearchConfig.
pub fn request_to_config(
    limit: i64,
    offset: i64,
    rerank: impl Into<Option<bool>>,
) -> DualSearchConfig {
    let depth = (limit + offset).max(50);
    DualSearchConfig {
        primary_depth: depth,
        secondary_depth: depth,
        rrf_k: 60.0,
        rerank_top_n: 50,
        rerank: rerank.into().unwrap_or(false),
    }
}

/// Build the reranker by sharing the embedder's client, base URL and bearer.
/// Deliberately NOT `Reranker::from_env`: that constructor is not used here.
fn build_reranker() -> Option<Reranker> {
    let remote_e = crate::remote_embedder::RemoteEmbedder::from_env("").ok()?;
    let model = std::env::var("CCC_RERANK_MODEL")
        .ok()
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| crate::rerank::DEFAULT_MODEL.to_string());
    Some(Reranker::from_embedder(&remote_e, &model, Duration::from_secs(10)))
}

pub async fn execute_search(
    project_root: &Path,
    embedder: &CodeEmbedder,
    query_params: &Params,
    query: &str,
    languages: &[String],
    paths: &[String],
    limit: i64,
    offset: i64,
    rerank: bool,
    mode: Option<&str>,
) -> Result<SearchExecution> {
    let db_path = target_sqlite_db_path(project_root);
    if !db_path.exists() {
        bail!(
            "Index database not found at {}. Run `cccrust index` first.",
            db_path.display()
        );
    }
    let pool = crate::db::open_readonly_pool(&db_path).await?;
    let meta = crate::index_model::read_meta(&pool).await?;
    crate::index_model::check_compatible(meta.as_ref(), &embedder.state_key())?;
    let query_vec = embedder.embed(query, query_params).await?;

    let is_dual = mode.map_or(false, |m| m == "dual");
    if is_dual || rerank {
        let config = request_to_config(limit, offset, rerank);
        let reranker = if rerank { build_reranker() } else { None };
        let outcome = dual_search(
            &pool,
            &query_vec,
            None,
            query,
            reranker.as_ref(),
            &config,
        )
        .await?;

        let status_str = match &outcome.rerank_status {
            RerankStatus::Reranked => "Reranked".to_string(),
            RerankStatus::Fallback(kind) => format!("Fallback({kind})"),
            RerankStatus::Skipped => "Skipped".to_string(),
        };

        let off = offset.max(0) as usize;
        let lim = limit.max(0) as usize;
        let results = outcome
            .results
            .into_iter()
            .skip(off)
            .take(lim)
            .map(|r| SearchResult {
                file_path: r.file_path,
                language: r.language,
                content: r.content,
                start_line: r.start_line,
                end_line: r.end_line,
                score: r.score,
            })
            .collect();

        Ok(SearchExecution {
            results,
            rerank_status: Some(status_str),
            primary_only: Some(outcome.primary_only),
        })
    } else {
        let rows = crate::query::query_codebase(
            &pool,
            &query_vec,
            limit,
            offset,
            languages,
            paths,
        )
        .await?;
        let results = rows
            .into_iter()
            .map(|r| SearchResult {
                file_path: r.file_path,
                language: r.language,
                content: r.content,
                start_line: r.start_line,
                end_line: r.end_line,
                score: r.score,
            })
            .collect();
        Ok(SearchExecution {
            results,
            rerank_status: None,
            primary_only: None,
        })
    }
}
