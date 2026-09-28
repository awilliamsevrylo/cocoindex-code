//! In-flight cap: a concurrent mock counts simultaneous requests.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;

/// Mock `/v1/embeddings`: holds each request `hold`, records peak concurrency.
async fn counting_mock(hold: Duration) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let (now, peak) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let peak_out = peak.clone();
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = listener.accept().await.unwrap();
            let (now, peak) = (now.clone(), peak.clone());
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                    let head = String::from_utf8_lossy(&buf[..p]).to_lowercase();
                    let len: usize = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .map(|v| v.trim().parse().unwrap())
                        .unwrap_or(0);
                    if buf.len() >= p + 4 + len {
                        break;
                    }
                }
                let cur = now.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(cur, Ordering::SeqCst);
                tokio::time::sleep(hold).await;
                now.fetch_sub(1, Ordering::SeqCst);
                let body = json!({"data":[{"embedding":[0.1, 0.2]}]}).to_string();
                let reply = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(reply.as_bytes()).await;
            });
        }
    });
    (base, peak_out)
}

async fn run(cap: usize, calls: usize) -> usize {
    let (base, peak) = counting_mock(Duration::from_millis(40)).await;
    let e = RemoteEmbedder::with_max_inflight("m", &base, None, cap).unwrap();
    let mut set = tokio::task::JoinSet::new();
    for i in 0..calls {
        let e = e.clone(); // clones must share the one semaphore
        set.spawn(async move { e.embed_batch(vec![format!("t{i}")], &Params::new()).await });
    }
    while let Some(r) = set.join_next().await {
        r.unwrap().unwrap();
    }
    peak.load(Ordering::SeqCst)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn peak_inflight_equals_cap() {
    // == not <=: a serial implementation (peak 1) must fail too.
    assert_eq!(run(8, 64).await, 8);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn control_uncapped_exceeds_eight() {
    // Instrument check: the mock can see more than 8 at once.
    assert!(run(1000, 64).await > 8);
}

#[test]
fn zero_cap_is_rejected() {
    assert!(RemoteEmbedder::with_max_inflight("m", "http://x/v1", None, 0).is_err());
}
