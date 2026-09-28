use super::*;
use serde_json::json;

fn global_local() -> EmbeddingSettings {
    EmbeddingSettings {
        provider: "sentence-transformers".into(),
        model: "BAAI/bge-small-en-v1.5".into(),
        device: None,
        min_interval_ms: None,
        indexing_params: None,
        query_params: Some(Some(params("prompt_name", "query"))),
    }
}

fn params(k: &str, v: &str) -> Params {
    let mut p = Params::new();
    p.insert(k.into(), json!(v));
    p
}

#[test]
fn no_override_inherits_global_exactly() {
    let g = global_local();
    let e = effective_embedding(&g, &ProjectEmbedding::default());
    assert_eq!(serde_json::to_value(&e).unwrap(), serde_json::to_value(&g).unwrap());
}

#[test]
fn model_override_gets_curated_params_not_globals() {
    let ov = ProjectEmbedding {
        provider: Some("litellm".into()),
        model: Some("voyage/voyage-code-4".into()),
        ..Default::default()
    };
    let e = effective_embedding(&global_local(), &ov);
    assert_eq!(e.model, "voyage/voyage-code-4");
    assert_eq!(e.indexing_params, Some(Some(params("input_type", "document"))));
    assert_eq!(e.query_params, Some(Some(params("input_type", "query"))));
}

#[test]
fn explicit_override_params_win() {
    let ov = ProjectEmbedding {
        provider: Some("litellm".into()),
        model: Some("voyage/voyage-4-large".into()),
        query_params: Some(params("input_type", "document")),
        ..Default::default()
    };
    let e = effective_embedding(&global_local(), &ov);
    assert_eq!(e.query_params, Some(Some(params("input_type", "document"))));
    assert_eq!(e.indexing_params, Some(Some(params("input_type", "document"))), "curated");
}

#[test]
fn uncurated_model_gets_no_params() {
    let ov = ProjectEmbedding { model: Some("BAAI/bge-base-en-v1.5".into()), ..Default::default() };
    let e = effective_embedding(&global_local(), &ov);
    assert_eq!(e.provider, "sentence-transformers", "provider inherited");
    assert_eq!(e.query_params, None, "global's params belong to global's model");
}

#[test]
fn mismatch_is_refused_with_both_models_named() {
    let meta = IndexMeta { model: "litellm:voyage/voyage-4-large".into(), dims: 1024 };
    let err = check_compatible(Some(&meta), "litellm:voyage/voyage-code-4").unwrap_err().to_string();
    assert!(err.contains("voyage-4-large") && err.contains("voyage-code-4"), "{err}");
    assert!(err.contains("ccc index"), "{err}");
}

#[test]
fn match_and_legacy_index_are_allowed() {
    let meta = IndexMeta { model: "litellm:m".into(), dims: 8 };
    assert!(check_compatible(Some(&meta), "litellm:m").is_ok());
    assert!(check_compatible(None, "litellm:m").is_ok(), "pre-meta index");
}

#[tokio::test]
async fn meta_round_trips_through_sqlite() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("t.db");
    let pool = crate::db::open_pool(&db).await.unwrap();
    assert_eq!(read_meta(&pool).await.unwrap(), None, "absent table = legacy");
    pool.close().await;
    let meta = IndexMeta { model: "litellm:voyage/voyage-4-large".into(), dims: 1024 };
    write_meta(&db, &meta).await.unwrap();
    write_meta(&db, &meta).await.unwrap(); // idempotent
    let pool = crate::db::open_readonly_pool(&db).await.unwrap();
    assert_eq!(read_meta(&pool).await.unwrap(), Some(meta));
}

#[test]
fn project_settings_yaml_carries_the_override() {
    let yaml = "embedding:\n  provider: litellm\n  model: voyage/voyage-code-4\n";
    let ps: crate::settings::ProjectSettings = serde_yaml::from_str(yaml).unwrap();
    let ov = ps.embedding.expect("embedding parsed");
    assert_eq!(ov.model.as_deref(), Some("voyage/voyage-code-4"));
    let plain: crate::settings::ProjectSettings = serde_yaml::from_str("include_patterns: []\n").unwrap();
    assert!(plain.embedding.is_none());
    assert!(!serde_yaml::to_string(&plain).unwrap().contains("embedding"), "absent stays absent");
}
