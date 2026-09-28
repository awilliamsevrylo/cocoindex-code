//! One logical embed request: bounded retries, halve-on-oversize, fail fast
//! on hard client errors (policy in `retry.rs`). The in-flight permit is
//! held per attempt only, so a sleeping retry never blocks other files.

use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use serde::Deserialize;

use crate::embedder_params::Params;
use crate::remote_embedder::RemoteEmbedder;
use crate::retry::{Action, classify, parse_retry_after};

#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingData>,
}

#[derive(Deserialize)]
struct EmbeddingData {
    #[serde(default)]
    index: Option<usize>,
    embedding: Vec<f32>,
}

/// Outcome of a single HTTP attempt.
enum Attempt {
    Ok(Vec<Vec<f32>>),
    Http { status: u16, body: String, retry_after: Option<Duration> },
    Transport(String),
}

async fn attempt(e: &RemoteEmbedder, texts: &[String], params: &Params) -> Result<Attempt> {
    let url = format!("{}/embeddings", e.base_url);
    let _permit = e.inflight.acquire().await.map_err(|_| anyhow!("embedder closed"))?;
    let mut req = e.client.post(&url).timeout(e.timeout).json(&e.body(texts, params));
    if let Some(key) = &e.api_key {
        req = req.bearer_auth(key);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(err) => return Ok(Attempt::Transport(err.without_url().to_string())),
    };
    let status = resp.status();
    if !status.is_success() {
        let retry_after = parse_retry_after(resp.headers().get("retry-after").and_then(|v| v.to_str().ok()));
        let mut body = resp.text().await.unwrap_or_default();
        body.truncate(400);
        return Ok(Attempt::Http { status: status.as_u16(), body, retry_after });
    }
    match resp.json::<EmbeddingResponse>().await {
        Ok(parsed) => Ok(Attempt::Ok(order_vectors(parsed.data, texts.len())?)),
        Err(err) => Ok(Attempt::Transport(format!("response decode failed: {err}"))),
    }
}

/// Embed `texts` with the retry / split policy. Never logs the key.
pub async fn fetch(e: &RemoteEmbedder, texts: Vec<String>, params: &Params) -> Result<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let mut n = 0u32;
    loop {
        let (status, body, ra) = match attempt(e, &texts, params).await? {
            Attempt::Ok(v) => return Ok(v),
            Attempt::Http { status, body, retry_after } => (Some(status), body, retry_after),
            Attempt::Transport(msg) => (None, msg, None),
        };
        match classify(status, &body, texts.len(), n, e.max_retries, ra) {
            Action::Retry(d) => {
                tracing::warn!(status = ?status, attempt = n + 1, delay_ms = d.as_millis() as u64, "embed retry");
                tokio::time::sleep(d).await;
                n += 1;
            }
            Action::Split => {
                let right = texts[texts.len() / 2..].to_vec();
                let left = texts[..texts.len() / 2].to_vec();
                let (a, b) = tokio::try_join!(Box::pin(fetch(e, left, params)), Box::pin(fetch(e, right, params)))?;
                return Ok(a.into_iter().chain(b).collect());
            }
            Action::Fail => {
                let what = status.map(|s| s.to_string()).unwrap_or_else(|| "transport error".into());
                bail!("embedding request to {}/embeddings failed ({what}) after {} attempt(s): {body}", e.base_url, n + 1);
            }
        }
    }
}

/// Put vectors back in input order (by `index` when present) and refuse a
/// short or malformed response instead of mis-assigning vectors to chunks.
fn order_vectors(data: Vec<EmbeddingData>, expected: usize) -> Result<Vec<Vec<f32>>> {
    if data.len() != expected {
        bail!("embedding API returned {} vectors for {expected} inputs", data.len());
    }
    let mut out: Vec<Option<Vec<f32>>> = vec![None; expected];
    for (pos, d) in data.into_iter().enumerate() {
        let i = d.index.unwrap_or(pos);
        let slot = out.get_mut(i).ok_or_else(|| anyhow!("embedding index {i} out of range"))?;
        if slot.replace(d.embedding).is_some() {
            bail!("embedding index {i} returned twice");
        }
    }
    Ok(out.into_iter().map(|v| v.expect("every index filled")).collect())
}
