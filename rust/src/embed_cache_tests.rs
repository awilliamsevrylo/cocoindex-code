//! Vector cache: keys, hits without HTTP, in-batch dedupe.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;
use crate::embed_cache::{EmbedCache, cache_key};

/// Mock that answers every request (echoing one vector per input, derived
/// from the text length) and counts the inputs it was sent — the "spend".
async fn spend_mock() -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let spent = Arc::new(AtomicUsize::new(0));
    let s2 = spent.clone();
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = listener.accept().await.unwrap();
            let spent = s2.clone();
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
                spent.fetch_add(input.len(), Ordering::SeqCst);
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
    (base, spent)
}

fn p(v: &str) -> Params {
    let mut m = Params::new();
    m.insert("input_type".into(), json!(v));
    m
}

async fn cached(base: &str, dir: &std::path::Path) -> RemoteEmbedder {
    let cache = EmbedCache::open(&dir.join("c.db")).await.unwrap();
    RemoteEmbedder::new("m", base, None).unwrap().with_cache(Some(cache))
}

#[test]
fn key_depends_on_model_params_and_text() {
    let k = cache_key("m", &p("document"), "t");
    assert_ne!(k, cache_key("m2", &p("document"), "t"));
    assert_ne!(k, cache_key("m", &p("query"), "t"), "document vs query vectors differ");
    assert_ne!(k, cache_key("m", &p("document"), "t2"));
    assert_eq!(k, cache_key("m", &p("document"), "t"));
    // Length prefixing: unprefixed, both of these flatten to "v1a{}{}".
    assert_ne!(cache_key("a{}", &Params::new(), ""), cache_key("a", &Params::new(), "{}"));
}

#[tokio::test]
async fn second_call_is_served_from_cache() {
    let (base, spent) = spend_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let e = cached(&base, dir.path()).await;
    let texts = vec!["alpha".to_string(), "beta!".to_string()];
    let a = e.embed_batch(texts.clone(), &p("document")).await.unwrap();
    assert_eq!(spent.load(Ordering::SeqCst), 2);
    // A new embedder on the same db file = a restarted process.
    let e2 = cached(&base, dir.path()).await;
    let b = e2.embed_batch(texts, &p("document")).await.unwrap();
    assert_eq!(spent.load(Ordering::SeqCst), 2, "cache hit must not call the API");
    assert_eq!(a, b);
}

#[tokio::test]
async fn params_are_part_of_the_key() {
    let (base, spent) = spend_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let e = cached(&base, dir.path()).await;
    e.embed_batch(vec!["same".into()], &p("document")).await.unwrap();
    e.embed_batch(vec!["same".into()], &p("query")).await.unwrap();
    assert_eq!(spent.load(Ordering::SeqCst), 2, "a query vector is not a document vector");
}

#[tokio::test]
async fn duplicates_in_a_batch_are_sent_once_and_order_is_kept() {
    let (base, spent) = spend_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let e = cached(&base, dir.path()).await;
    let t = |s: &str| s.to_string();
    let out = e.embed_batch(vec![t("aa"), t("b"), t("aa"), t("cccc"), t("b")], &p("document")).await.unwrap();
    assert_eq!(spent.load(Ordering::SeqCst), 3);
    let lens: Vec<f32> = out.iter().map(|v| v[0]).collect();
    assert_eq!(lens, vec![2.0, 1.0, 2.0, 4.0, 1.0]);
}

#[tokio::test]
async fn partial_hit_only_fetches_the_misses() {
    let (base, spent) = spend_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let e = cached(&base, dir.path()).await;
    e.embed_batch(vec!["known".into()], &p("document")).await.unwrap();
    let out = e.embed_batch(vec!["x".into(), "known".into(), "yy".into()], &p("document")).await.unwrap();
    assert_eq!(spent.load(Ordering::SeqCst), 3, "1 earlier + 2 misses");
    assert_eq!(out.iter().map(|v| v[0]).collect::<Vec<_>>(), vec![1.0, 5.0, 2.0]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_callers_pay_once_for_the_same_text() {
    // The measured failure: 100 identical files, all missed at once, paid 100x.
    let (base, spent) = spend_mock().await;
    let dir = tempfile::tempdir().unwrap();
    let e = cached(&base, dir.path()).await;
    let mut set = tokio::task::JoinSet::new();
    for _ in 0..50 {
        let e = e.clone();
        set.spawn(async move { e.embed_batch(vec!["shared chunk".into()], &p("document")).await });
    }
    while let Some(r) = set.join_next().await {
        assert_eq!(r.unwrap().unwrap()[0][0], 12.0);
    }
    assert_eq!(spent.load(Ordering::SeqCst), 1, "one fetch for 50 concurrent identical requests");
}
