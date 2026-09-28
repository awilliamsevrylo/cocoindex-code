//! Pure weighted reciprocal-rank fusion for dual (multi-arm) search.
//!
//! **std-only, not yet wired** — run standalone with:
//! `rustc --edition 2024 --test rust/src/fusion.rs -o /tmp/fusion_test`
//! After `mod fusion;` is added to the crate, `cargo test fusion` covers it.
//!
//! Contract (POC 11b, rust/EXECUTION_PLAN.md):
//!
//! - Fused score is exactly `sum(weight[role] / (rrf_k + one_based_rank))`.
//!   Raw cosine similarity NEVER enters the math, tie-break, or any floor —
//!   mutants that mix score into the contribution fail the invariance tests.
//! - Each arm's `candidate_depth` truncates that arm BEFORE fusion.
//!   `depth == 0`: the arm contributes no votes.
//! - Same-arm duplicate identity votes ONCE: the first occurrence wins (lists
//!   are rank-ordered, so first == best rank); later duplicates are dropped.
//! - Two different line ranges in one file are distinct chunk identities.
//! - The union across arms is preserved: candidates missing from one arm or a
//!   partial/empty arm still appear, with provenance per voting arm.
//! - Order is deterministic regardless of arm arrival order: score desc, then
//!   best_rank asc, then identity `(file_path, start_line, end_line)` asc.
//!   `index_matches` list in canonical role order (Primary, then Secondary).
//! - Similarity values are carried verbatim in provenance, including NaN —
//!   never sanitized, never read. No pagination here; callers slice the Vec.

#[cfg(test)]
#[path = "fusion_tests.rs"]
mod tests;

use std::collections::{HashMap, HashSet};
use std::fmt;

/// Which index produced a ranked list. Canonical display order: Primary first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ArmRole {
    Primary,
    Secondary,
}

impl ArmRole {
    pub fn as_str(self) -> &'static str {
        match self {
            ArmRole::Primary => "primary",
            ArmRole::Secondary => "secondary",
        }
    }
}

impl fmt::Display for ArmRole {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Chunk identity: the dedupe key. Distinct ranges in one file are distinct.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Identity {
    pub file_path: String,
    pub start_line: i64,
    pub end_line: i64,
}

impl Identity {
    pub fn new(file_path: &str, start_line: i64, end_line: i64) -> Self {
        Self { file_path: file_path.to_string(), start_line, end_line }
    }
}

/// One ranked candidate from one arm. `similarity` is provenance only.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub identity: Identity,
    pub content: String,
    pub similarity: f64,
}

impl Candidate {
    pub fn new(file_path: &str, start_line: i64, end_line: i64, content: &str, similarity: f64) -> Self {
        Self {
            identity: Identity::new(file_path, start_line, end_line),
            content: content.to_string(),
            similarity,
        }
    }
}

/// One arm: its ranked list plus the explicit depth applied before fusion.
#[derive(Debug, Clone)]
pub struct RankedArm {
    pub role: ArmRole,
    pub candidate_depth: usize,
    pub candidates: Vec<Candidate>,
}

impl RankedArm {
    pub fn new(role: ArmRole, candidate_depth: usize, candidates: Vec<Candidate>) -> Self {
        Self { role, candidate_depth, candidates }
    }
}

/// Per-role fusion weights.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ArmWeights {
    pub primary: f64,
    pub secondary: f64,
}

impl ArmWeights {
    pub fn new(primary: f64, secondary: f64) -> Self {
        Self { primary, secondary }
    }

    pub fn get(self, role: ArmRole) -> f64 {
        match role {
            ArmRole::Primary => self.primary,
            ArmRole::Secondary => self.secondary,
        }
    }

    /// Zero weight for ONE role is legal (its candidates still join the union,
    /// contributing 0). NaN / infinite / negative / all-zero are rejected.
    fn validate(self) -> Result<(), String> {
        for (name, w) in [("primary", self.primary), ("secondary", self.secondary)] {
            if w.is_nan() {
                return Err(format!("weight for `{name}` is NaN; weights must be finite"));
            }
            if w.is_infinite() {
                return Err(format!("weight for `{name}` is infinite; weights must be finite"));
            }
            if w < 0.0 {
                return Err(format!("weight for `{name}` is negative; weights must be non-negative"));
            }
        }
        if self.primary == 0.0 && self.secondary == 0.0 {
            return Err("at least one weight must be positive".to_string());
        }
        Ok(())
    }
}

/// Invalid configuration, reported before any fusion work happens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FusionError(pub String);

impl fmt::Display for FusionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for FusionError {}

/// Fusion configuration. Default matches POC 11b: `rrf_k = 60`, weights 1/1.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FusionConfig {
    pub rrf_k: f64,
    pub weights: ArmWeights,
}

impl Default for FusionConfig {
    fn default() -> Self {
        Self { rrf_k: 60.0, weights: ArmWeights::new(1.0, 1.0) }
    }
}

impl FusionConfig {
    pub fn validate(&self) -> Result<(), FusionError> {
        if self.rrf_k.is_nan() || self.rrf_k.is_infinite() || self.rrf_k <= 0.0 {
            return Err(FusionError(format!("rrf_k must be positive and finite, got {}", self.rrf_k)));
        }
        self.weights.validate().map_err(FusionError)
    }
}

/// One arm's vote on one fused result: role, that arm's one-based rank
/// (post-depth), and that arm's raw similarity (verbatim, may be NaN).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IndexMatch {
    pub role: ArmRole,
    pub rank: usize,
    pub similarity: f64,
}

/// One fused output row. `score` is the fused RRF score (never a cosine).
#[derive(Debug, Clone, PartialEq)]
pub struct FusedResult {
    pub identity: Identity,
    /// Content carried from the primary arm if it voted, else the secondary.
    pub content: String,
    pub score: f64,
    /// Lowest one-based rank this identity earned across voting arms.
    pub best_rank: usize,
    /// One entry per voting arm, canonical order (Primary, then Secondary).
    pub index_matches: Vec<IndexMatch>,
}

struct Agg {
    content: String,
    score: f64,
    best_rank: usize,
    primary: Option<IndexMatch>,
    secondary: Option<IndexMatch>,
}

/// Fuse ranked arms into one deterministic ranking. `Err` on invalid config or
/// a duplicate arm role; validated empty arms yield `Ok(vec![])`.
pub fn fuse_ranks(config: &FusionConfig, arms: &[RankedArm]) -> Result<Vec<FusedResult>, FusionError> {
    config.validate()?;
    for role in [ArmRole::Primary, ArmRole::Secondary] {
        if arms.iter().filter(|a| a.role == role).count() > 1 {
            return Err(FusionError(format!("duplicate arm role: {role}")));
        }
    }

    let mut union: HashMap<&Identity, Agg> = HashMap::new();
    for arm in arms {
        let weight = config.weights.get(arm.role);
        let mut seen: HashSet<&Identity> = HashSet::new();
        for (i, cand) in arm.candidates.iter().take(arm.candidate_depth).enumerate() {
            let rank = i + 1; // one-based, after truncation
            if !seen.insert(&cand.identity) {
                continue; // same-arm duplicate: first (best-rank) occurrence votes
            }
            let agg = union.entry(&cand.identity).or_insert_with(|| Agg {
                content: String::new(),
                score: 0.0,
                best_rank: usize::MAX,
                primary: None,
                secondary: None,
            });
            agg.score += weight / (config.rrf_k + rank as f64);
            if rank < agg.best_rank {
                agg.best_rank = rank;
            }
            let m = IndexMatch { role: arm.role, rank, similarity: cand.similarity };
            match arm.role {
                ArmRole::Primary => {
                    if agg.primary.is_none() {
                        agg.primary = Some(m);
                        agg.content = cand.content.clone();
                    }
                }
                ArmRole::Secondary => {
                    if agg.secondary.is_none() {
                        agg.secondary = Some(m);
                        if agg.primary.is_none() {
                            agg.content = cand.content.clone();
                        }
                    }
                }
            }
        }
    }

    let mut out: Vec<FusedResult> = union
        .into_iter()
        .map(|(identity, agg)| {
            let mut index_matches = Vec::with_capacity(2);
            if let Some(m) = agg.primary {
                index_matches.push(m);
            }
            if let Some(m) = agg.secondary {
                index_matches.push(m);
            }
            FusedResult {
                identity: identity.clone(),
                content: agg.content,
                score: agg.score,
                best_rank: agg.best_rank,
                index_matches,
            }
        })
        .collect();

    out.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(a.best_rank.cmp(&b.best_rank))
            .then(a.identity.file_path.cmp(&b.identity.file_path))
            .then(a.identity.start_line.cmp(&b.identity.start_line))
            .then(a.identity.end_line.cmp(&b.identity.end_line))
    });
    Ok(out)
}
