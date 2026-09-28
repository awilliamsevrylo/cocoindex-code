//! Wire-level tests for `Reranker` against one-shot local HTTP mocks.

use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

/// Read one HTTP request; return (head, JSON body).
async fn read_request(sock: &mut TcpStream) -> (String, Value) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let (head_end, content_len) = loop {
        let n = sock.read(&mut chunk).await.unwrap();
        buf.extend_from_slice(&chunk[..n]);
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..p]).to_lowercase();
            let len = head
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .map(|v| v.trim().parse::<usize>().unwrap())
                .unwrap_or(0);
            break (p + 4, len);
        }
    };
    while buf.len() < head_end + content_len {
        let n = sock.read(&mut chunk).await.unwrap();
        buf.extend_from_slice(&chunk[..n]);
    }
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    (head, serde_json::from_slice(&buf[head_end..head_end + content_len]).unwrap())
}

/// Serve exactly one request; handle -> (request line, auth header, body).
async fn mock_once(status: &'static str, response: String) -> (String, JoinHandle<(String, String, Value)>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let (head, body) = read_request(&mut sock).await;
        let line = head.lines().next().unwrap_or("").to_string();
        let auth = head.lines().find(|l| l.to_lowercase().starts_with("authorization:")).unwrap_or("").to_string();
        let reply = format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{response}",
            response.len()
        );
        sock.write_all(reply.as_bytes()).await.unwrap();
        (line, auth, body)
    });
    (base, handle)
}

/// Accept one request and never answer (drives the client timeout).
async fn mock_silent() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let _ = read_request(&mut sock).await;
        tokio::time::sleep(Duration::from_secs(30)).await;
    });
    base
}

fn docs() -> Vec<String> {
    vec!["alpha".into(), "beta".into(), "gamma".into()]
}

fn reranker(base: &str, timeout: Duration) -> Reranker {
    Reranker::new(base, Some("sekrit-key".into()), DEFAULT_MODEL, timeout).unwrap()
}

fn data(items: Value) -> String {
    json!({ "object": "list", "data": items, "model": "rerank-2.5" }).to_string()
}

/// Serve `items` for 3 documents with top_k 2; return the outcome.
async fn outcome_for(items: Value) -> RerankOutcome {
    let (base, _h) = mock_once("200 OK", data(items)).await;
    reranker(&base, Duration::from_secs(5)).rerank("q", &docs(), Some(2)).await
}

fn malformed(out: &RerankOutcome) -> String {
    match out {
        RerankOutcome::Fallback(Fallback::Malformed(why)) => why.clone(),
        other => panic!("expected Malformed fallback, got {other:?}"),
    }
}

#[tokio::test]
async fn success_sends_the_wire_body_and_reorders_candidates() {
    let items = json!([{ "index": 2, "relevance_score": 0.9 }, { "index": 0, "relevance_score": 0.4 }]);
    let (base, h) = mock_once("200 OK", data(items)).await;
    let out = reranker(&base, Duration::from_secs(5)).rerank("q", &docs(), Some(2)).await;
    let (line, auth, body) = h.await.unwrap();
    assert!(line.starts_with("POST /v1/rerank "), "{line}");
    assert_eq!(auth.trim(), "authorization: Bearer sekrit-key");
    assert_eq!(body, json!({ "query": "q", "documents": docs(), "model": "rerank-2.5", "top_k": 2 }));
    assert!(!out.is_fallback());
    assert_eq!(out, RerankOutcome::Reranked(vec![Ranked { index: 2, score: 0.9 }, Ranked { index: 0, score: 0.4 }]));
    assert_eq!(out.apply(vec!["A", "B", "C"]), vec![("C", Some(0.9)), ("A", Some(0.4))]);
}

#[tokio::test]
async fn no_top_k_asks_for_all_and_strips_the_voyage_prefix() {
    let items = json!([
        { "index": 1, "relevance_score": 0.8 },
        { "index": 2, "relevance_score": 0.5 },
        { "index": 0, "relevance_score": 0.1 }
    ]);
    let (base, h) = mock_once("200 OK", data(items)).await;
    let r = Reranker::new(&base, None, "voyage/rerank-2.5", Duration::from_secs(5)).unwrap();
    let out = r.rerank("q", &docs(), Some(0)).await;
    let (_, auth, body) = h.await.unwrap();
    assert!(auth.is_empty(), "no key configured -> no Authorization header");
    assert_eq!(body["model"], "rerank-2.5");
    assert!(body.get("top_k").is_none(), "top_k 0 means all: not sent");
    assert_eq!(out.apply(vec![0, 1, 2]).into_iter().map(|(c, _)| c).collect::<Vec<_>>(), vec![1, 2, 0]);
}

#[tokio::test]
async fn server_error_falls_back_to_retrieval_order_without_the_key() {
    let (base, _h) = mock_once("500 Internal Server Error", json!({ "error": "boom" }).to_string()).await;
    let out = reranker(&base, Duration::from_secs(5)).rerank("q", &docs(), Some(2)).await;
    assert_eq!(out, RerankOutcome::Fallback(Fallback::Http(500)));
    assert!(out.is_fallback());
    assert!(!format!("{out:?}").contains("sekrit-key"));
    assert_eq!(out.apply(vec![1, 2, 3]), vec![(1, None), (2, None), (3, None)]);
}

#[tokio::test]
async fn timeout_falls_back() {
    let base = mock_silent().await;
    let started = std::time::Instant::now();
    let out = reranker(&base, Duration::from_millis(200)).rerank("q", &docs(), Some(2)).await;
    assert_eq!(out, RerankOutcome::Fallback(Fallback::Timeout));
    assert!(started.elapsed() < Duration::from_secs(5), "timeout not honoured: {:?}", started.elapsed());
    if let RerankOutcome::Fallback(f) = &out {
        assert_eq!(f.kind(), "timeout");
    }
}

#[tokio::test]
async fn out_of_range_index_is_rejected() {
    let out = outcome_for(json!([{ "index": 3, "relevance_score": 0.9 }, { "index": 0, "relevance_score": 0.4 }])).await;
    assert!(malformed(&out).contains("index 3 out of range for 3 documents"), "{out:?}");
}

#[tokio::test]
async fn duplicate_index_is_rejected() {
    let out = outcome_for(json!([{ "index": 1, "relevance_score": 0.9 }, { "index": 1, "relevance_score": 0.4 }])).await;
    assert!(malformed(&out).contains("index 1 returned twice"), "{out:?}");
}

#[tokio::test]
async fn malformed_entries_are_rejected() {
    let cases = [
        (json!([{ "index": "1", "relevance_score": 0.9 }, { "index": 0, "relevance_score": 0.4 }]), "malformed index"),
        (json!([{ "index": -1, "relevance_score": 0.9 }, { "index": 0, "relevance_score": 0.4 }]), "malformed index"),
        (json!([{ "index": 1.5, "relevance_score": 0.9 }, { "index": 0, "relevance_score": 0.4 }]), "malformed index"),
        (json!([{ "relevance_score": 0.9 }, { "index": 0, "relevance_score": 0.4 }]), "malformed index"),
        (json!([{ "index": 1 }, { "index": 0, "relevance_score": 0.4 }]), "malformed relevance_score"),
        (json!([{ "index": 1, "relevance_score": 0.9 }]), "1 results for 2 expected"),
    ];
    for (items, want) in cases {
        let out = outcome_for(items.clone()).await;
        assert!(malformed(&out).contains(want), "{items} -> {out:?}");
    }
}

#[tokio::test]
async fn non_json_body_and_missing_data_are_rejected() {
    let (base, _h) = mock_once("200 OK", "not json".into()).await;
    let out = reranker(&base, Duration::from_secs(5)).rerank("q", &docs(), Some(2)).await;
    assert!(malformed(&out).contains("decode failed"), "{out:?}");
    let (base, _h) = mock_once("200 OK", json!({ "results": [] }).to_string()).await;
    let out = reranker(&base, Duration::from_secs(5)).rerank("q", &docs(), Some(2)).await;
    assert!(malformed(&out).contains("no data array"), "{out:?}");
}

#[tokio::test]
async fn empty_documents_make_no_request() {
    // Port 9 (discard) is never served here: a request would be a Transport fallback.
    let out = reranker("http://127.0.0.1:9/v1", Duration::from_secs(1)).rerank("q", &[], Some(5)).await;
    assert_eq!(out, RerankOutcome::Reranked(Vec::new()));
}
