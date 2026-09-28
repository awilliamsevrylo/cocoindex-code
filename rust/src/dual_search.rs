//! Dual-index search orchestration: query the PRIMARY db and the SECONDARY
//! (code-model) db independently, fuse the two ranked lists with RRF, then
//! optionally rerank the top N.
//!
//! Division of labour, deliberately:
//!
//! * [`fuse_and_decide`] is **pure** — no pools, no HTTP, no clock. It turns
//!   two `QueryResult` lists into one fused list plus a `primary_only` flag. The
//!   tests exercise this directly instead of standing up sqlite fixtures.
//! * [`apply_rerank_decision`] is **pure** too — it takes an already-obtained
//!   [`RerankOutcome`] and decides the final ordering and the reported status.
//! * [`dual_search`] is the thin async shell that does the I/O and calls the two
//!   pure functions in order.
//!
//! Fusion itself lives in [`crate::fusion`]: rank-based, weighted, deterministic,
//! with `candidate_depth` applied per arm before any vote is counted. This module
//! never re-implements that math — it only projects `QueryResult` onto
//! `Candidate`/`Identity` and back.
//!
//! A missing or empty secondary index is **not** an error: it degrades to
//! primary-only and says so in the result. Rerank is likewise never fatal — a
//! fallback keeps the fused order verbatim and is reported as
//! `RerankStatus::Fallback(kind)`, so an evaluation never scores a fallback as
//! a rerank.

#[cfg(test)]
#[path = "dual_search_tests.rs"]
mod tests;

use std::collections::HashMap;

use anyhow::Result;
use sqlx::SqlitePool;

use crate::fusion::{ArmRole, Candidate, FusionConfig, FusionError, Identity, RankedArm, fuse_ranks};
use crate::query::query_codebase;
use crate::rerank::{RerankOutcome, Reranker};
use crate::schema::QueryResult;

/// Default rerank pass width.
const DEFAULT_RERANK_TOP_N: usize = 50;

/// Knobs for one dual-search call.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DualSearchConfig {
    /// Candidate depth requested from the primary index (its own `k`).
    pub primary_depth: i64,
    /// Candidate depth requested from the secondary index.
    pub secondary_depth: i64,
    /// RRF smoothing constant: contribution is `weight / (rrf_k + rank)`.
    pub rrf_k: f64,
    /// How many fused candidates the rerank pass sees.
    pub rerank_top_n: usize,
    /// Whether to attempt the rerank pass at all.
    pub rerank: bool,
}

impl Default for DualSearchConfig {
    fn default() -> Self {
        Self {
            primary_depth: 50,
            secondary_depth: 50,
            rrf_k: 60.0,
            rerank_top_n: DEFAULT_RERANK_TOP_N,
            rerank: true,
        }
    }
}

impl DualSearchConfig {
    /// The fusion config implied by these knobs (equal arm weights).
    pub fn fusion_config(&self) -> FusionConfig {
        FusionConfig { rrf_k: self.rrf_k, ..FusionConfig::default() }
    }
}

/// What actually happened on the rerank pass. Reported, never inferred.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RerankStatus {
    /// The reranker answered and the top N are in rerank order.
    Reranked,
    /// The reranker failed; the fused order is intact. Payload is
    /// [`crate::rerank::Fallback::kind`].
    Fallback(String),
    /// Not attempted (disabled, `rerank_top_n == 0`, nothing to rerank, or no
    /// reranker configured).
    Skipped,
}

impl RerankStatus {
    pub fn as_str(&self) -> &str {
        match self {
            RerankStatus::Reranked => "reranked",
            RerankStatus::Fallback(k) => k,
            RerankStatus::Skipped => "skipped",
        }
    }
}

/// The outcome of one dual-search call.
#[derive(Debug, Clone, PartialEq)]
pub struct DualSearchResult {
    /// Fused ranking (rerank-ordered if `rerank_status == Reranked`).
    pub results: Vec<QueryResult>,
    /// True when the secondary arm was absent or empty and fusion ran on the
    /// primary arm alone. Degraded, not failed.
    pub primary_only: bool,
    pub rerank_status: RerankStatus,
}

/// Project a `QueryResult` onto a fusion candidate. Similarity is provenance
/// only; fusion is rank-based and never reads it.
fn to_candidate(r: &QueryResult) -> Candidate {
    Candidate::new(&r.file_path, r.start_line, r.end_line, &r.content, r.score)
}

/// Build the arm for one index. `depth <= 0` means the arm may not vote, so we
/// do not even hand it candidates (and `fuse_ranks` would truncate to nothing).
fn arm(role: ArmRole, depth: i64, rows: &[QueryResult]) -> RankedArm {
    let depth = depth.max(0) as usize;
    RankedArm::new(role, depth, rows.iter().map(to_candidate).collect())
}

/// Identity -> language, so fused rows keep the language of the chunk the arms
/// actually returned. Primary wins on a collision (both arms index the same
/// chunk, so the language is the same string anyway).
fn language_index(arms: &[&[QueryResult]]) -> HashMap<Identity, String> {
    let mut map: HashMap<Identity, String> = HashMap::new();
    for rows in arms {
        for r in *rows {
            map.entry(Identity::new(&r.file_path, r.start_line, r.end_line))
                .or_insert_with(|| r.language.clone());
        }
    }
    map
}

/// Fuse two ranked lists and decide whether this was a primary-only run.
///
/// Pure: no I/O, no clock, no pools.
///
/// `secondary == None` (or an empty list) means primary-only; the returned flag
/// says so and no error is raised. A config error (non-positive `rrf_k`) still
/// surfaces as `FusionError`, because that is a caller bug, not a data shape.
pub fn fuse_and_decide(
    config: &DualSearchConfig,
    primary: &[QueryResult],
    secondary: Option<&[QueryResult]>,
) -> Result<(Vec<QueryResult>, bool), FusionError> {
    let secondary = secondary.unwrap_or(&[]);
    let primary_only = secondary.is_empty();

    let arms = match primary_only {
        true => vec![arm(ArmRole::Primary, config.primary_depth, primary)],
        false => vec![
            arm(ArmRole::Primary, config.primary_depth, primary),
            arm(ArmRole::Secondary, config.secondary_depth, secondary),
        ],
    };

    let language = language_index(&[primary, secondary]);
    let fused = fuse_ranks(&config.fusion_config(), &arms)?;

    let results = fused
        .into_iter()
        .map(|f| {
            let language = language.get(&f.identity).cloned().unwrap_or_default();
            QueryResult {
                file_path: f.identity.file_path,
                language,
                content: f.content,
                start_line: f.identity.start_line,
                end_line: f.identity.end_line,
                score: f.score,
            }
        })
        .collect();

    Ok((results, primary_only))
}

/// Decide the final list and the reported status from an already-obtained
/// rerank outcome.
///
/// Pure. On fallback the fused order is returned **unchanged** (the reranker
/// never reorders what it could not rank) and the status carries the fallback
/// kind. Anything that makes the pass pointless — disabled, zero width, nothing
/// to rerank, no outcome supplied — is `Skipped`, not an error.
pub fn apply_rerank_decision(
    enabled: bool,
    rerank_top_n: usize,
    outcome: Option<RerankOutcome>,
    fused: Vec<QueryResult>,
) -> (Vec<QueryResult>, RerankStatus) {
    if !enabled || rerank_top_n == 0 || fused.is_empty() {
        return (fused, RerankStatus::Skipped);
    }
    let Some(outcome) = outcome else {
        return (fused, RerankStatus::Skipped);
    };

    let status = match &outcome {
        RerankOutcome::Fallback(f) => RerankStatus::Fallback(f.kind().to_string()),
        RerankOutcome::Reranked(_) => RerankStatus::Reranked,
    };

    let mut fused = fused;
    let tail = if fused.len() > rerank_top_n { fused.split_off(rerank_top_n) } else { Vec::new() };
    let head = fused;

    let mut results: Vec<QueryResult> = outcome
        .apply(head)
        .into_iter()
        .map(|(mut r, score)| {
            if let Some(s) = score {
                r.score = s;
            }
            r
        })
        .collect();
    results.extend(tail);
    (results, status)
}

/// Run the full dual-search pipeline against live indexes.
///
/// `secondary` is `None` whenever the secondary index is not configured; the
/// call then degrades to primary-only and reports it. `reranker` is `None`
/// whenever rerank is not configured — that is `Skipped`, never an error.
pub async fn dual_search(
    primary_pool: &SqlitePool,
    primary_query_vec: &[f32],
    secondary: Option<(&SqlitePool, &[f32])>,
    query_text: &str,
    reranker: Option<&Reranker>,
    config: &DualSearchConfig,
) -> Result<DualSearchResult> {
    let primary_rows = fetch_arm(primary_pool, primary_query_vec, config.primary_depth).await?;
    let secondary_rows = match secondary {
        Some((pool, vec)) => fetch_arm(pool, vec, config.secondary_depth).await?,
        None => Vec::new(),
    };

    let (fused, primary_only) =
        fuse_and_decide(config, &primary_rows, Some(secondary_rows.as_slice()))?;

    let (results, rerank_status) = if config.rerank {
        if let Some(reranker) = reranker {
            let n = config.rerank_top_n.min(fused.len());
            if n == 0 {
                (fused, RerankStatus::Skipped)
            } else {
                let documents: Vec<String> = fused[..n].iter().map(|r| r.content.clone()).collect();
                let outcome = reranker.rerank(query_text, &documents, Some(n)).await;
                apply_rerank_decision(config.rerank, config.rerank_top_n, Some(outcome), fused)
            }
        } else {
            apply_rerank_decision(config.rerank, config.rerank_top_n, None, fused)
        }
    } else {
        apply_rerank_decision(config.rerank, config.rerank_top_n, None, fused)
    };

    Ok(DualSearchResult { results, primary_only, rerank_status })
}

/// One arm's raw retrieval. `depth <= 0` short-circuits: a non-positive `k`
/// would either be rejected by sqlite-vec or ask for nothing, and the fusion
/// layer already treats depth 0 as "this arm may not vote".
async fn fetch_arm(pool: &SqlitePool, query_vec: &[f32], depth: i64) -> Result<Vec<QueryResult>> {
    if depth <= 0 || query_vec.is_empty() {
        return Ok(Vec::new());
    }
    query_codebase(pool, query_vec, depth, 0, &[], &[]).await
}