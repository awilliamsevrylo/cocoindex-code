//! Wire-level tests for `RemoteEmbedder` against a one-shot local HTTP mock.

use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Serve exactly one request; return (base_url, handle -> (auth header, body)).
async fn mock_once(
    status: &'static str,
    response: String,
) -> (String, tokio::task::JoinHandle<(String, Value)>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
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
        let auth = head
            .lines()
            .find(|l| l.to_lowercase().starts_with("authorization:"))
            .unwrap_or("")
            .to_string();
        let body: Value = serde_json::from_slice(&buf[head_end..head_end + content_len]).unwrap();
        let reply = format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{response}",
            response.len()
        );
        sock.write_all(reply.as_bytes()).await.unwrap();
        (auth, body)
    });
    (base, handle)
}

fn params(input_type: &str) -> Params {
    let mut p = Params::new();
    p.insert("input_type".into(), json!(input_type));
    p
}

fn two_vectors_reversed() -> String {
    // Out of order on purpose: index must win over position.
    json!({"data": [{"index": 1, "embedding": [2.0, 2.0]}, {"index": 0, "embedding": [1.0, 1.0]}]})
        .to_string()
}

#[tokio::test]
async fn indexing_params_reach_the_wire() {
    let (base, h) = mock_once("200 OK", two_vectors_reversed()).await;
    let e = RemoteEmbedder::new("voyage/voyage-4-large", &base, Some("tok".into())).unwrap();
    e.embed_batch(vec!["a".into(), "b".into()], &params("document")).await.unwrap();
    let (auth, body) = h.await.unwrap();
    assert_eq!(body["input_type"], "document");
    assert_eq!(body["model"], "voyage-4-large", "voyage/ prefix stripped on the wire");
    assert_eq!(body["input"], json!(["a", "b"]));
    assert_eq!(auth.trim(), "authorization: Bearer tok");
}

#[tokio::test]
async fn query_params_reach_the_wire() {
    let (base, h) = mock_once("200 OK", json!({"data":[{"embedding":[0.5]}]}).to_string()).await;
    let e = RemoteEmbedder::new("voyage-4-large", &base, None).unwrap();
    e.embed_batch(vec!["q".into()], &params("query")).await.unwrap();
    let (auth, body) = h.await.unwrap();
    assert_eq!(body["input_type"], "query");
    assert!(auth.is_empty(), "no key configured -> no Authorization header");
}

#[tokio::test]
async fn params_cannot_override_model_or_input() {
    let (base, h) = mock_once("200 OK", json!({"data":[{"embedding":[0.5]}]}).to_string()).await;
    let e = RemoteEmbedder::new("m1", &base, None).unwrap();
    let mut p = params("document");
    p.insert("model".into(), json!("evil"));
    p.insert("input".into(), json!(["evil"]));
    e.embed_batch(vec!["real".into()], &p).await.unwrap();
    let (_, body) = h.await.unwrap();
    assert_eq!(body["model"], "m1");
    assert_eq!(body["input"], json!(["real"]));
}

#[tokio::test]
async fn vectors_follow_response_index_not_position() {
    let (base, _h) = mock_once("200 OK", two_vectors_reversed()).await;
    let e = RemoteEmbedder::new("m", &base, None).unwrap();
    let v = e.embed_batch(vec!["a".into(), "b".into()], &Params::new()).await.unwrap();
    assert_eq!(v, vec![vec![1.0, 1.0], vec![2.0, 2.0]]);
}

#[tokio::test]
async fn short_response_is_an_error_not_a_misalignment() {
    let (base, _h) = mock_once("200 OK", json!({"data":[{"embedding":[1.0]}]}).to_string()).await;
    let e = RemoteEmbedder::new("m", &base, None).unwrap();
    let err = e.embed_batch(vec!["a".into(), "b".into()], &Params::new()).await.unwrap_err();
    assert!(err.to_string().contains("1 vectors for 2 inputs"), "{err}");
}

#[tokio::test]
async fn http_error_surfaces_status_without_the_key() {
    let (base, _h) = mock_once("401 Unauthorized", json!({"error":"unauthorized"}).to_string()).await;
    let e = RemoteEmbedder::new("m", &base, Some("sekrit-key".into())).unwrap();
    let err = e.embed_batch(vec!["a".into()], &Params::new()).await.unwrap_err().to_string();
    assert!(err.contains("401"), "{err}");
    assert!(!err.contains("sekrit-key"), "key leaked into error: {err}");
}
