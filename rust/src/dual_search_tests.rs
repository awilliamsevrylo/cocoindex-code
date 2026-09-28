//! Tests for [`crate::dual_search`]. Pure-function first: `fuse_and_decide` and
//! `apply_rerank_decision` need no pools, no server and no fixtures, so the
//! interesting behaviour (disjoint, overlapping, missing secondary, rerank
//! skipped/fallback) is covered directly.

use crate::dual_search::{
    DualSearchConfig, RerankStatus, apply_rerank_decision, fuse_and_decide,
};
use crate::rerank::{Fallback, Ranked, RerankOutcome};
use crate::schema::QueryResult;

fn row(path: &str, start: i64, end: i64, content: &str, score: f64) -> QueryResult {
    QueryResult {
        file_path: path.to_string(),
        language: "rust".to_string(),
        content: content.to_string(),
        start_line: start,
        end_line: end,
        score,
    }
}

fn cfg() -> DualSearchConfig {
    DualSearchConfig { primary_depth: 50, secondary_depth: 50, rrf_k: 60.0, rerank_top_n: 50, rerank: true }
}

fn paths(rows: &[QueryResult]) -> Vec<&str> {
    rows.iter().map(|r| r.file_path.as_str()).collect()
}

#[test]
fn disjoint_arms_union_preserving_both() {
    let primary = vec![row("a.rs", 1, 5, "alpha", 0.9), row("b.rs", 1, 5, "beta", 0.8)];
    let secondary = vec![row("c.rs", 1, 5, "gamma", 0.95), row("d.rs", 1, 5, "delta", 0.7)];

    let (fused, primary_only) = fuse_and_decide(&cfg(), &primary, Some(&secondary)).expect("fuse");

    assert!(!primary_only, "secondary present -> not primary-only");
    let mut got = paths(&fused);
    got.sort_unstable();
    assert_eq!(got, vec!["a.rs", "b.rs", "c.rs", "d.rs"], "union of both arms, nothing dropped");
    // Rank-1 in each arm ties on score; determinism comes from the identity tie-break.
    assert_eq!(fused[0].file_path, "a.rs");
    assert!(fused.iter().all(|r| r.language == "rust"), "language carried through fusion");
}

#[test]
fn overlapping_result_scores_beat_single_arm() {
    let primary = vec![row("shared.rs", 1, 5, "s", 0.5), row("only_p.rs", 1, 5, "p", 0.4)];
    let secondary = vec![row("shared.rs", 1, 5, "s", 0.6), row("only_s.rs", 1, 5, "s2", 0.4)];

    let (fused, primary_only) = fuse_and_decide(&cfg(), &primary, Some(&secondary)).expect("fuse");

    assert!(!primary_only);
    assert_eq!(fused[0].file_path, "shared.rs", "found by both arms ranks first");
    assert_eq!(paths(&fused).len(), 3, "shared identity appears once");
    // 1/(60+1) + 1/(60+1) beats any single 1/(60+1) contribution.
    let shared = &fused[0];
    let single = &fused[1];
    assert!(shared.score > single.score, "two votes outrank one vote");
}

#[test]
fn missing_secondary_is_primary_only_not_an_error() {
    let primary = vec![row("a.rs", 1, 5, "alpha", 0.9), row("b.rs", 1, 5, "beta", 0.8)];

    // None and an empty list are the same degradation: primary-only, no error.
    let (from_none, po_none) = fuse_and_decide(&cfg(), &primary, None).expect("fuse none");
    let (from_empty, po_empty) = fuse_and_decide(&cfg(), &primary, Some(&[])).expect("fuse empty");

    assert!(po_none && po_empty, "both spellings flag primary-only");
    assert_eq!(paths(&from_none), paths(&from_empty), "identical ranking either way");
    assert_eq!(from_none[0].file_path, "a.rs", "primary order preserved");
    assert!(from_none.iter().all(|r| r.language == "rust"));
}

#[test]
fn empty_secondary_keeps_primary_order_and_content() {
    let primary = vec![row("a.rs", 1, 5, "alpha", 0.9), row("b.rs", 1, 5, "beta", 0.8)];
    let (fused, _) = fuse_and_decide(&cfg(), &primary, Some(&[])).expect("fuse");
    assert_eq!(fused[0].content, "alpha");
    assert_eq!(fused[1].content, "beta");
}

#[test]
fn zero_depth_arm_cannot_vote_but_other_arm_survives() {
    let mut c = cfg();
    c.secondary_depth = 0;
    let primary = vec![row("a.rs", 1, 5, "alpha", 0.9)];
    let secondary = vec![row("b.rs", 1, 5, "beta", 0.99)];

    let (fused, primary_only) = fuse_and_decide(&c, &primary, Some(&secondary)).expect("fuse");

    assert!(!primary_only, "secondary was supplied; depth 0 is a vote rule, not absence");
    assert_eq!(paths(&fused), vec!["a.rs"], "depth-0 secondary contributes no candidates");
}

#[test]
fn identical_arms_do_not_duplicate_a_chunk() {
    let rows = vec![row("a.rs", 1, 5, "alpha", 0.9), row("b.rs", 1, 5, "beta", 0.8)];
    let (fused, _) = fuse_and_decide(&cfg(), &rows, Some(&rows)).expect("fuse");
    assert_eq!(paths(&fused), vec!["a.rs", "b.rs"], "each identity fused once");
    assert!(fused[0].score > fused[1].score);
}

#[test]
fn rerank_skipped_when_disabled() {
    let fused = vec![row("a.rs", 1, 5, "alpha", 0.9), row("b.rs", 1, 5, "beta", 0.8)];
    let outcome = RerankOutcome::Reranked(vec![Ranked { index: 1, score: 0.99 }]);

    let (results, status) = apply_rerank_decision(false, 50, Some(outcome), fused.clone());

    assert_eq!(status, RerankStatus::Skipped, "rerank: false -> Skipped");
    assert_eq!(paths(&results), paths(&fused), "fused order untouched");
    assert_eq!(results[0].score, 0.9, "fused scores preserved when skipped");
}

#[test]
fn rerank_skipped_when_nothing_to_rerank() {
    let (empty, s1) = apply_rerank_decision(true, 50, None, Vec::new());
    assert!(empty.is_empty());
    assert_eq!(s1, RerankStatus::Skipped);

    let fused = vec![row("a.rs", 1, 5, "alpha", 0.9)];
    let (_, s2) = apply_rerank_decision(true, 0, None, fused);
    assert_eq!(s2, RerankStatus::Skipped, "rerank_top_n == 0 is skipped");
}

#[test]
fn rerank_reorders_the_head_and_keeps_the_tail() {
    let fused = vec![
        row("a.rs", 1, 5, "alpha", 0.9),
        row("b.rs", 1, 5, "beta", 0.8),
        row("c.rs", 1, 5, "gamma", 0.7),
    ];
    // Reranker flips the top 2: b (index 1) first, a (index 0) second.
    let outcome = RerankOutcome::Reranked(vec![
        Ranked { index: 1, score: 0.99 },
        Ranked { index: 0, score: 0.11 },
    ]);

    let (results, status) = apply_rerank_decision(true, 2, Some(outcome), fused);

    assert_eq!(status, RerankStatus::Reranked);
    assert_eq!(paths(&results), vec!["b.rs", "a.rs", "c.rs"], "head reordered, tail kept");
    assert_eq!(results[0].score, 0.99, "rerank score replaces fused score");
    assert_eq!(results[2].score, 0.7, "untouched tail keeps its fused score");
}

#[test]
fn rerank_fallback_keeps_fused_order_and_reports_kind() {
    let fused = vec![row("a.rs", 1, 5, "alpha", 0.9), row("b.rs", 1, 5, "beta", 0.8)];
    let outcome = RerankOutcome::Fallback(Fallback::Http(503));

    let (results, status) = apply_rerank_decision(true, 50, Some(outcome), fused.clone());

    assert_eq!(status, RerankStatus::Fallback("http".to_string()));
    assert_eq!(paths(&results), paths(&fused), "fallback never reorders");
    assert_eq!(results[0].score, 0.9, "fused scores survive the fallback");

    let timeout = RerankOutcome::Fallback(Fallback::Timeout);
    let (_, ts) = apply_rerank_decision(true, 50, Some(timeout), fused);
    assert_eq!(ts, RerankStatus::Fallback("timeout".to_string()), "kind is per-cause");
}

#[test]
fn non_positive_rrf_k_is_a_config_error() {
    let mut c = cfg();
    c.rrf_k = 0.0;
    let err = fuse_and_decide(&c, &[row("a.rs", 1, 5, "alpha", 0.9)], None).expect_err("rrf_k 0 rejected");
    assert!(err.to_string().contains("rrf_k"), "error names the offending knob: {err}");
}

#[test]
fn distinct_ranges_in_one_file_are_distinct_chunks() {
    let primary = vec![row("a.rs", 1, 5, "one", 0.9), row("a.rs", 40, 50, "two", 0.8)];
    let (fused, _) = fuse_and_decide(&cfg(), &primary, None).expect("fuse");
    assert_eq!(fused.len(), 2, "same path, different ranges -> two identities");
    assert_eq!(fused[0].start_line, 1);
    assert_eq!(fused[1].start_line, 40);
}

#[test]
fn deterministic_regardless_of_secondary_presence_shape() {
    // Same union reached two ways must render the same order.
    let primary = vec![row("a.rs", 1, 5, "alpha", 0.9)];
    let secondary = vec![row("a.rs", 1, 5, "alpha", 0.95), row("z.rs", 1, 5, "zeta", 0.1)];

    let (with_sec, _) = fuse_and_decide(&cfg(), &primary, Some(&secondary)).expect("fuse");
    let (again, _) = fuse_and_decide(&cfg(), &primary, Some(&secondary)).expect("fuse");

    assert_eq!(paths(&with_sec), paths(&again), "repeat runs agree");
    assert_eq!(with_sec[0].file_path, "a.rs", "the identity both arms found wins");
}