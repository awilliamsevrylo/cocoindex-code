//! The write-through seam: a cache that cannot take the vectors must not take
//! the batch down with it.
//!
//! `put_many` absorbs its own write errors, so the one `Err` left at the call
//! site is a `PoolTimedOut` acquire at the 300s cap — measured reachable at
//! ~150 concurrent callers queued behind a wedged writer. `cached_embed.rs`
//! used to `put?` that straight into the index. This is that call site.

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;
use crate::embed_cache::EmbedCache;
use crate::embedder_params::Params;
use crate::remote_embedder::RemoteEmbedder;
use crate::single_flight::SingleFlight;

/// Echoes one vector per input, derived from the text length — the same wire
/// behaviour the cache tests' mock uses, so a hit and a fetch are comparable.
async fn echo_mock() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                let (head_end, len) = loop {
                    let n = sock.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..p]).to_lowercase();
                        let len: usize = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .map(|v| v.trim().parse().unwrap())
                            .unwrap_or(0);
                        break (p + 4, len);
                    }
                };
                while buf.len() < head_end + len {
                    let n = sock.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                }
                let body: Value = serde_json::from_slice(&buf[head_end..head_end + len]).unwrap();
                let input = body["input"].as_array().unwrap();
                let data: Vec<Value> = input
                    .iter()
                    .enumerate()
                    .map(|(i, t)| json!({"index": i, "embedding": [t.as_str().unwrap().len() as f32, 1.0]}))
                    .collect();
                let out = json!({ "data": data }).to_string();
                let reply = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{out}",
                    out.len()
                );
                sock.write_all(reply.as_bytes()).await.unwrap();
            });
        }
    });
    base
}

fn p(v: &str) -> Params {
    let mut m = Params::new();
    m.insert("input_type".into(), json!(v));
    m
}

/// A cache whose writer pool is already closed: the next `put_many` takes the
/// real `acquire()` failure path and returns `Err`, without waiting 300s.
async fn unusable_writer(dir: &std::path::Path) -> EmbedCache {
    let cache = EmbedCache::open(&dir.join("c.db")).await.unwrap();
    cache.close_writer_for_test().await;
    cache
}

#[tokio::test]
async fn a_failed_write_through_does_not_fail_the_batch() {
    let base = echo_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let cache = unusable_writer(dir.path()).await;
    let e = RemoteEmbedder::new("m", &base, None).unwrap().with_cache(Some(cache.clone()));
    let texts = vec!["alpha".to_string(), "beta!".to_string()];

    let out = e
        .embed_batch(texts.clone(), &p("document"))
        .await
        .expect("a cache that cannot be written must not fail the batch");
    assert_eq!(
        out.iter().map(|v| v[0]).collect::<Vec<_>>(),
        vec![5.0, 5.0],
        "the vectors are still returned to the caller"
    );

    // The vectors were real and the cache was genuinely unusable: the same
    // batch misses again rather than serving a half-written row.
    let again = e.embed_batch(texts, &p("document")).await.unwrap();
    assert_eq!(again, out, "a dropped write is a miss next time, not corruption");
}

/// The same seam through the public path, with the write reaching the caller
/// as an error only after `get_many` already missed.
#[tokio::test]
async fn an_unusable_writer_still_serves_every_text() {
    let base = echo_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let cache = unusable_writer(dir.path()).await;
    let e = RemoteEmbedder::new("m", &base, None).unwrap().with_cache(Some(cache));
    let texts: Vec<String> = (0..8).map(|i| "x".repeat(i + 1)).collect();
    let out = e.embed_batch(texts, &p("document")).await.unwrap();
    let lens: Vec<f32> = out.iter().map(|v| v[0]).collect();
    assert_eq!(lens, (1..=8).map(|i| i as f32).collect::<Vec<_>>());
}

#[tokio::test]
async fn a_failed_write_through_leaves_no_wrong_length_hit() {
    let dir = tempfile::tempdir().unwrap();
    let cache = unusable_writer(dir.path()).await;
    let flight = SingleFlight::default();
    let base = echo_mock().await;
    let e = RemoteEmbedder::new("m", &base, None).unwrap().with_cache(Some(cache.clone()));

    let got = embed_cached(&e, &cache, &flight, vec!["hello".into()], &p("document"))
        .await
        .unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0], vec![5.0, 1.0]);
}