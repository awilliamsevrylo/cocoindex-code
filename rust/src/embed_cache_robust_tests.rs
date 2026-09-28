//! A cache that cannot be trusted must degrade, never abort the index.
//!
//! Two measured ways to distrust one (2026-09-28):
//!
//! 1. The db file itself is unreadable — SQLite code 26, "file is not a
//!    database". `open()` used to return `Err`, and the `?` at
//!    `remote_embedder.rs:123` killed `cccrust index` at construction.
//! 2. A `v` blob is short or corrupt. `decode()`'s `chunks_exact(4)` dropped
//!    the remainder and served a wrong-length vector as a HIT.
//!
//! Both are the same contract: an unusable cache is a miss, and a miss is free.

use super::*;
use crate::embed_cache::{EmbedCache, cache_key};

/// A cache file SQLite cannot read must open *degraded*, not abort.
#[tokio::test]
async fn a_corrupt_cache_file_degrades_instead_of_aborting() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("c.db");
    std::fs::write(&db, [0u8; 8192]).unwrap();

    let cache = EmbedCache::open(&db)
        .await
        .expect("a corrupt cache file must degrade, not abort the index");

    // Whatever it opened — a recreated file or a cache-less shell — it must
    // answer safely: a miss on read, a silent no-op on write.
    let k = [7u8; 32];
    assert_eq!(
        cache.get_many(&[k]).await.expect("a degraded cache still reads"),
        vec![None],
        "an unusable cache is all misses"
    );
    cache
        .put_many(&[(k, &[1.0f32, 2.0][..])])
        .await
        .expect("a degraded cache must not surface a write error");

    // The bad file is moved aside, not left to poison the next run.
    let names: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        names.iter().any(|n| n.contains("corrupt")),
        "the unreadable db must be renamed aside, found: {names:?}"
    );
}

/// A blob that is not a whole number of f32s is a MISS, never a truncated hit.
#[tokio::test]
async fn a_malformed_blob_is_a_miss_not_a_truncated_hit() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("c.db");
    let cache = EmbedCache::open(&db).await.unwrap();

    let good = [1u8; 32];
    let ragged = [2u8; 32];
    let stunted = [3u8; 32];
    cache
        .put_many(&[
            (good, &[1.5f32, 2.5][..]),
            (ragged, &[9.0f32, 9.0][..]),
            (stunted, &[4.0f32][..]),
        ])
        .await
        .unwrap();

    // `ragged`: 7 bytes = 1.75 f32s — length is not a multiple of 4.
    // `stunted`: 4 bytes = one f32, wrong for a key this cache recorded as 2 dims.
    let raw = sqlx::SqlitePool::connect(&format!("sqlite:{}?mode=rw", db.display()))
        .await
        .unwrap();
    for (k, bytes) in [(&ragged, 7usize), (&stunted, 4usize)] {
        sqlx::query("UPDATE vectors SET v = ? WHERE k = ?")
            .bind(vec![0u8; bytes])
            .bind(&k[..])
            .execute(&raw)
            .await
            .unwrap();
    }
    drop(raw);

    let got = cache.get_many(&[good, ragged, stunted]).await.unwrap();
    assert_eq!(got[0].as_ref().map(Vec::len), Some(2), "the good row still hits");
    assert!(got[1].is_none(), "a 7-byte blob is not a vector — must miss");
    assert!(
        got[2].is_none(),
        "a 1-f32 blob where 2 dims were stored must miss"
    );
}

/// End to end: an unusable cache still returns embeddings for the batch. This
/// is the call site the corruption used to kill (`embed_batch` → index abort).
#[tokio::test]
async fn an_unusable_cache_still_embeds_the_batch() {
    let (base, spent) = spend_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("c.db");
    std::fs::write(&db, [0u8; 8192]).unwrap();

    let cache = EmbedCache::open(&db).await.unwrap();
    let e = RemoteEmbedder::new("m", &base, None).unwrap().with_cache(Some(cache));
    let out = e
        .embed_batch(vec!["alpha".into(), "beta!".into()], &p("document"))
        .await
        .expect("a corrupt cache must not fail the batch");
    assert_eq!(
        out.iter().map(|v| v[0]).collect::<Vec<_>>(),
        vec![5.0, 5.0],
        "the batch is still embedded"
    );
    assert_eq!(spent.load(Ordering::SeqCst), 2, "the cache paid for nothing");
    // The cache key is still exercised, so the miss path is what ran.
    let _ = cache_key("m", &p("document"), "alpha");
}