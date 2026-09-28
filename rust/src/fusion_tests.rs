//! Tests for the standalone rank-fusion module. Run:
//! `rustc --edition 2024 --test rust/src/fusion.rs -o /tmp/fusion_test && /tmp/fusion_test`

use super::*;

fn cand(f: &str, s: i64, e: i64, sim: f64) -> Candidate {
    Candidate::new(f, s, e, "body", sim)
}

fn arm(role: ArmRole, depth: usize, c: Vec<Candidate>) -> RankedArm {
    RankedArm::new(role, depth, c)
}

fn default_cfg() -> FusionConfig {
    FusionConfig::default()
}

fn ids(r: &[FusedResult]) -> Vec<(String, i64, i64)> {
    r.iter().map(|x| (x.identity.file_path.clone(), x.identity.start_line, x.identity.end_line)).collect()
}

#[test]
fn disjoint_union_preserves_both_arms() {
    let p = arm(ArmRole::Primary, 2, vec![cand("a.rs", 1, 5, 0.9), cand("b.rs", 1, 5, 0.8)]);
    let s = arm(ArmRole::Secondary, 2, vec![cand("c.rs", 1, 9, 0.7), cand("d.rs", 1, 9, 0.6)]);
    let out = fuse_ranks(&default_cfg(), &[p.clone(), s.clone()]).unwrap();
    assert_eq!(out.len(), 4);
    for r in &out {
        assert_eq!(r.index_matches.len(), 1);
        let want = 1.0 / (60.0 + r.index_matches[0].rank as f64);
        assert!((r.score - want).abs() < 1e-12, "score {} want {}", r.score, want);
    }
    // arrival order does not matter
    let rev = fuse_ranks(&default_cfg(), &[s, p]).unwrap();
    assert_eq!(ids(&out), ids(&rev));
}

#[test]
fn full_overlap_votes_from_both_arms() {
    let v = vec![cand("x.rs", 1, 2, 0.5), cand("y.rs", 1, 2, 0.4)];
    let out = fuse_ranks(
        &default_cfg(),
        &[arm(ArmRole::Primary, 2, v.clone()), arm(ArmRole::Secondary, 2, v)],
    )
    .unwrap();
    assert_eq!(out.len(), 2);
    assert!((out[0].score - 2.0 / 61.0).abs() < 1e-12);
    assert!((out[1].score - 2.0 / 62.0).abs() < 1e-12);
    assert_eq!(out[0].best_rank, 1);
    assert_eq!(out[0].index_matches.len(), 2);
    assert_eq!(out[0].index_matches[0].role, ArmRole::Primary);
    assert_eq!(out[0].index_matches[1].role, ArmRole::Secondary);
}

#[test]
fn formula_exact_for_nondefault_k_and_weights() {
    // k=10, primary weight 3.0, secondary weight 0.5.
    // identity in both at primary rank 2, secondary rank 4:
    let cfg = FusionConfig { rrf_k: 10.0, weights: ArmWeights::new(3.0, 0.5) };
    let p = arm(ArmRole::Primary, 2, vec![cand("q.rs", 1, 1, 0.1), cand("m.rs", 1, 1, 0.2)]);
    let s = arm(ArmRole::Secondary, 4, vec![
        cand("n1.rs", 1, 1, 0.3),
        cand("n2.rs", 1, 1, 0.3),
        cand("n3.rs", 1, 1, 0.3),
        cand("m.rs", 1, 1, 0.9),
    ]);
    let out = fuse_ranks(&cfg, &[p, s]).unwrap();
    let m = out.iter().find(|r| r.identity.file_path == "m.rs").unwrap();
    let expected = 3.0 / (10.0 + 2.0) + 0.5 / (10.0 + 4.0);
    assert!((m.score - expected).abs() < 1e-12, "got {} want {}", m.score, expected);
    assert_eq!(m.index_matches[1].rank, 4);
    assert_eq!(m.best_rank, 2);
}

#[test]
fn depth_truncates_before_fusion_and_zero_depth_votes_nothing() {
    let deep = vec![cand("a.rs", 1, 1, 0.9), cand("b.rs", 1, 1, 0.9), cand("c.rs", 1, 1, 0.9)];
    // secondary depth 1 => only rank-1 of secondary counts.
    let out = fuse_ranks(
        &default_cfg(),
        &[arm(ArmRole::Primary, 3, deep.clone()), arm(ArmRole::Secondary, 1, deep.clone())],
    )
    .unwrap();
    assert_eq!(out.len(), 3);
    assert_eq!(&out[0].identity.file_path, "a.rs");
    assert_eq!(out[0].index_matches.len(), 2);
    assert!((out[0].score - (1.0 / 61.0 + 1.0 / 61.0)).abs() < 1e-12);
    assert_eq!(out[1].index_matches.len(), 1); // b, c only from primary
    // primary depth 0 => nothing from primary votes
    let out2 = fuse_ranks(
        &default_cfg(),
        &[arm(ArmRole::Primary, 0, deep.clone()), arm(ArmRole::Secondary, 3, deep.clone())],
    )
    .unwrap();
    assert_eq!(out2.len(), 3);
    for r in &out2 {
        assert_eq!(r.index_matches.len(), 1);
        assert_eq!(r.index_matches[0].role, ArmRole::Secondary);
    }
    // depth beyond list length is just the whole list
    let out3 = fuse_ranks(&default_cfg(), &[arm(ArmRole::Primary, 999, deep.clone())]).unwrap();
    assert_eq!(out3.len(), 3);
}

#[test]
fn empty_arm_still_yields_union() {
    let out = fuse_ranks(&default_cfg(), &[
        arm(ArmRole::Primary, 1, vec![cand("a.rs", 1, 1, 0.9)]),
        arm(ArmRole::Secondary, 1, vec![])]).unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].index_matches.len(), 1);
    let out_empty = fuse_ranks(&default_cfg(), &[
        arm(ArmRole::Primary, 1, vec![]), arm(ArmRole::Secondary, 1, vec![])]).unwrap();
    assert!(out_empty.is_empty());
    let solo = fuse_ranks(&default_cfg(), &[arm(ArmRole::Primary, 1, vec![cand("a.rs", 1, 1, 0.9)])]).unwrap();
    assert_eq!(solo.len(), 1);
}

#[test]
fn same_arm_duplicate_votes_once_first_rank_wins() {
    let dup = vec![
        cand("a.rs", 1, 1, 0.9),
        cand("b.rs", 1, 1, 0.8),
        cand("a.rs", 1, 1, 0.3), // duplicate identity at a worse rank
    ];
    let out = fuse_ranks(&default_cfg(), &[arm(ArmRole::Primary, 3, dup)]).unwrap();
    assert_eq!(out.len(), 2);
    let a = out.iter().find(|r| r.identity.file_path == "a.rs").unwrap();
    assert_eq!(a.index_matches.len(), 1);
    assert_eq!(a.index_matches[0].rank, 1, "first/best occurrence wins");
    assert!((a.score - 1.0 / 61.0).abs() < 1e-12, "duplicate earned no second vote: {}", a.score);
    // and its provenance similarity is the FIRST occurrence's value
    assert!((a.index_matches[0].similarity - 0.9).abs() < 1e-12);
}

#[test]
fn same_file_distinct_ranges_are_distinct() {
    let p = arm(ArmRole::Primary, 2, vec![cand("f.rs", 1, 10, 0.9), cand("f.rs", 11, 20, 0.8)]);
    let out = fuse_ranks(&default_cfg(), &[p]).unwrap();
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].identity.end_line, 10);
    assert_eq!(out[1].identity.start_line, 11);
}

#[test]
fn ties_break_stably_by_best_rank_then_identity() {
    // two identities each rank-1 in exactly one arm => equal score 1/61.
    // best_rank ties (both 1) => identity lexicographic wins; file "m" before "n".
    let p = arm(ArmRole::Primary, 1, vec![cand("n.rs", 1, 1, 0.5)]);
    let s = arm(ArmRole::Secondary, 1, vec![cand("m.rs", 1, 1, 0.5)]);
    let out = fuse_ranks(&default_cfg(), &[p.clone(), s.clone()]).unwrap();
    assert_eq!(&out[0].identity.file_path, "m.rs");
    assert_eq!(&out[1].identity.file_path, "n.rs");
    assert_eq!(out[0].score, out[1].score);
    // equal score AND equal best_rank AND same file, different start_line:
    // each range is rank-1 in exactly one arm => both 1/61, best_rank 1.
    let p2 = arm(ArmRole::Primary, 1, vec![cand("f.rs", 1, 1, 0.1)]);
    let s2 = arm(ArmRole::Secondary, 1, vec![cand("f.rs", 5, 5, 0.1)]);
    let out2 = fuse_ranks(&default_cfg(), &[p2, s2]).unwrap();
    assert_eq!(out2[0].identity.start_line, 1, "tie resolves to lower start_line");
    // Equal score, different best_rank (k=3, weights 3/1): filler.rs primary
    // rank1 => 0.75 first; then zzz (secondary rank1, 1/4=0.25, best 1) must
    // beat aaa (primary rank9, 3/12=0.25, best 9) despite "aaa" < "zzz".
    let cfg3 = FusionConfig { rrf_k: 3.0, weights: ArmWeights::new(3.0, 1.0) };
    let pa = arm(ArmRole::Primary, 9, (1..=9).map(|i| cand(if i == 9 { "aaa.rs" } else { "filler.rs" }, 1, 1, 0.0)).collect());
    let sa = arm(ArmRole::Secondary, 1, vec![cand("zzz.rs", 1, 1, 0.0)]);
    let out3 = fuse_ranks(&cfg3, &[pa, sa]).unwrap();
    assert_eq!(out3[0].identity.file_path, "filler.rs"); // primary rank1 => 0.75
    assert_eq!(out3[1].identity.file_path, "zzz.rs", "best_rank beats identity lex at equal score");
    assert!((out3[1].score - 0.25).abs() < 1e-12);
    assert_eq!(out3[1].best_rank, 1);
    assert_eq!(out3[2].identity.file_path, "aaa.rs");
    assert!((out3[2].score - 0.25).abs() < 1e-12);
    assert_eq!(out3[2].best_rank, 9);
    assert_eq!(out3.len(), 3);
}

#[test]
fn similarity_values_never_affect_ranking_or_ties() {
    // Identical ranks/scores, wildly different (even reversed / NaN / inf) raw
    // similarities, must produce the SAME ordering and the SAME identity order.
    let make = |sims: Vec<f64>| RankedArm::new(
        ArmRole::Primary,
        3,
        vec![
            Candidate::new("a.rs", 1, 1, "b", sims[0]),
            Candidate::new("b.rs", 1, 1, "b", sims[1]),
            Candidate::new("c.rs", 1, 1, "b", sims[2]),
        ],
    );
    let baseline = fuse_ranks(&default_cfg(), &[make(vec![0.9, 0.8, 0.7]), make_secondary()]).unwrap();
    // reversed similarities
    let rev = fuse_ranks(&default_cfg(), &[make(vec![0.7, 0.8, 0.9]), make_secondary()]).unwrap();
    assert_eq!(ids(&baseline), ids(&rev));
    // wildly different magnitudes
    let big = fuse_ranks(&default_cfg(), &[make(vec![1e9, -1e9, 0.0]), make_secondary()]).unwrap();
    assert_eq!(ids(&baseline), ids(&big));
    // NaN and infinities as provenance
    let nan = fuse_ranks(&default_cfg(), &[make(vec![f64::NAN, f64::INFINITY, f64::NEG_INFINITY]), make_secondary()]).unwrap();
    assert_eq!(ids(&baseline), ids(&nan));
    // NaN is carried verbatim, not sanitized
    let n0 = nan[0].index_matches.iter().find(|m| m.role == ArmRole::Primary).unwrap().similarity;
    assert!(n0.is_nan());
    // scores are all rank-derived and finite
    for r in &nan {
        assert!(r.score.is_finite() && r.score > 0.0);
    }
}

fn make_secondary() -> RankedArm {
    arm(ArmRole::Secondary, 3, vec![
        cand("c.rs", 1, 1, 0.99),
        cand("b.rs", 1, 1, 0.01),
        cand("a.rs", 1, 1, 0.5),
    ])
}

#[test]
fn invalid_configs_are_rejected() {
    let ok = arm(ArmRole::Primary, 1, vec![cand("a.rs", 1, 1, 0.5)]);
    // rrf_k non-positive
    for k in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        let cfg = FusionConfig { rrf_k: k, weights: ArmWeights::new(1.0, 1.0) };
        let e = fuse_ranks(&cfg, &[ok.clone()]).unwrap_err();
        assert!(e.to_string().contains("rrf_k"), "{k} => {e}");
    }
    // negative weight
    let e = fuse_ranks(
        &FusionConfig { rrf_k: 60.0, weights: ArmWeights::new(-0.5, 1.0) },
        &[ok.clone()],
    )
    .unwrap_err();
    assert!(e.to_string().contains("negative"), "{e}");
    // infinite / NaN weight
    for w in [f64::INFINITY, f64::NAN] {
        let e = fuse_ranks(
            &FusionConfig { rrf_k: 60.0, weights: ArmWeights::new(w, 1.0) },
            &[ok.clone()],
        )
        .unwrap_err();
        assert!(e.to_string().contains("finite"), "{w} => {e}");
    }
    // all-zero weights
    let e = fuse_ranks(
        &FusionConfig { rrf_k: 60.0, weights: ArmWeights::new(0.0, 0.0) },
        &[ok.clone()],
    )
    .unwrap_err();
    assert!(e.to_string().contains("positive"), "{e}");
    // one zero weight is VALID; its arm still contributes union at score 0
    let zero_s = fuse_ranks(
        &FusionConfig { rrf_k: 60.0, weights: ArmWeights::new(1.0, 0.0) },
        &[arm(ArmRole::Primary, 1, vec![cand("a.rs", 1, 1, 0.5)]),
          arm(ArmRole::Secondary, 1, vec![cand("z.rs", 1, 1, 0.5)])],
    )
    .unwrap();
    assert_eq!(zero_s.len(), 2);
    let z = zero_s.iter().find(|r| r.identity.file_path == "z.rs").unwrap();
    assert_eq!(z.score, 0.0);
    assert_eq!(z.index_matches.len(), 1, "zero-weight arm still records provenance");
}

#[test]
fn duplicate_arm_role_is_rejected() {
    let a = arm(ArmRole::Primary, 1, vec![cand("a.rs", 1, 1, 0.5)]);
    let e = fuse_ranks(&default_cfg(), &[a.clone(), a]).unwrap_err();
    assert!(e.to_string().contains("duplicate"), "{e}");
}

#[test]
fn default_config_matches_poc11b() {
    let cfg = FusionConfig::default();
    assert_eq!(cfg.rrf_k, 60.0);
    assert_eq!(cfg.weights.primary, 1.0);
    assert_eq!(cfg.weights.secondary, 1.0);
    assert!(cfg.validate().is_ok());
}

#[test]
fn partial_secondary_missing_candidate_still_in_union() {
    // secondary (partial index) only knows the first chunk
    let p = arm(ArmRole::Primary, 3, vec![cand("a.rs", 1, 1, 0.9), cand("b.rs", 1, 1, 0.8), cand("c.rs", 1, 1, 0.7)]);
    let s = arm(ArmRole::Secondary, 1, vec![cand("a.rs", 1, 1, 0.95)]);
    let out = fuse_ranks(&default_cfg(), &[p, s]).unwrap();
    assert_eq!(out.len(), 3);
    assert_eq!(&out[0].identity.file_path, "a.rs", "overlap promotes");
    assert_eq!(out[0].index_matches.len(), 2);
    assert_eq!(out[1].index_matches.len(), 1);
    assert_eq!(out[2].index_matches.len(), 1);
}

#[test]
fn caller_slicing_yields_pagination() {
    let p = arm(ArmRole::Primary, 5, (1..=5).map(|i| cand(&format!("f{i}.rs"), 1, 1, 0.0)).collect());
    let out = fuse_ranks(&default_cfg(), &[p]).unwrap();
    let page: Vec<(String, i64, i64)> = out.into_iter().skip(1).take(2).map(|r| (r.identity.file_path, r.identity.start_line, r.identity.end_line)).collect();
    assert_eq!(page, vec![("f2.rs".to_string(), 1, 1), ("f3.rs".to_string(), 1, 1)]);
}
