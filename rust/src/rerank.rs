//! Voyage rerank client: `POST {base}/rerank` with `{query, documents, model,
//! top_k}`, through the same base URL and bearer as the embedder (so the
//! voyage-egress Worker when `CCC_EMBED_BASE_URL` points at it; the base
//! already ends in `/v1`).
//!
//! Rerank is an optional second pass over retrieved candidates, so it never
//! fails a query: an HTTP error, transport error, timeout or malformed
//! response becomes `RerankOutcome::Fallback` and the caller keeps retrieval
//! order. Fallback is its own variant with a `kind()` label, so an evaluation
//! counts fallbacks separately instead of scoring them as reranks.
//!
//! A response is accepted only when it names exactly `min(top_k, n)` distinct,
//! in-range integer indices with finite scores. Anything else is `Malformed`,
//! never a partial reorder. No retries: a retry costs more latency than the
//! fallback it would avoid.
//!
//! Env (`from_env`): base URL and bearer exactly as `RemoteEmbedder::from_env`;
//! `CCC_RERANK_MODEL` (default `rerank-2.5`); `CCC_RERANK_TIMEOUT_S` (default
//! 10). The key never appears in a fallback reason.

use std::time::Duration;

use anyhow::{Result, anyhow};
use serde_json::{Value, json};

use crate::remote_embedder::RemoteEmbedder;

pub const DEFAULT_MODEL: &str = "rerank-2.5";
const DEFAULT_TIMEOUT_S: u64 = 10;
/// litellm-style provider prefix; Voyage (and the Worker) take the bare id.
const VOYAGE_PREFIX: &str = "voyage/";

#[derive(Clone)]
pub struct Reranker {
    client: reqwest::Client,
    base_url: String,
    api_key: Option<String>,
    model: String,
    timeout: Duration,
}

/// One accepted result: `index` into the documents sent, Voyage's score.
#[derive(Debug, Clone, PartialEq)]
pub struct Ranked {
    pub index: usize,
    pub score: f64,
}

/// Why a rerank fell back to retrieval order.
#[derive(Debug, Clone, PartialEq)]
pub enum Fallback {
    Http(u16),
    Timeout,
    Transport(String),
    Malformed(String),
}

impl Fallback {
    /// Stable label for counting fallbacks by cause.
    pub fn kind(&self) -> &'static str {
        match self {
            Fallback::Http(_) => "http",
            Fallback::Timeout => "timeout",
            Fallback::Transport(_) => "transport",
            Fallback::Malformed(_) => "malformed",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum RerankOutcome {
    /// Server order (Voyage sorts by relevance, descending).
    Reranked(Vec<Ranked>),
    Fallback(Fallback),
}

impl RerankOutcome {
    pub fn is_fallback(&self) -> bool {
        matches!(self, RerankOutcome::Fallback(_))
    }

    /// Map onto the candidates the documents were built from (same list, same
    /// order). Reranked: the ranked candidates in rank order with their scores
    /// (only `top_k` of them when it was set). Fallback: every candidate in its
    /// original order, no score.
    pub fn apply<T>(self, candidates: Vec<T>) -> Vec<(T, Option<f64>)> {
        match self {
            RerankOutcome::Fallback(_) => candidates.into_iter().map(|c| (c, None)).collect(),
            RerankOutcome::Reranked(ranked) => {
                let mut slots: Vec<Option<T>> = candidates.into_iter().map(Some).collect();
                ranked
                    .into_iter()
                    .filter_map(|r| slots.get_mut(r.index)?.take().map(|c| (c, Some(r.score))))
                    .collect()
            }
        }
    }
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

impl Reranker {
    pub fn new(base_url: &str, api_key: Option<String>, model: &str, timeout: Duration) -> Result<Self> {
        let client = reqwest::Client::builder()
            .build()
            .map_err(|e| anyhow!("building HTTP client: {e}"))?;
        Ok(Self::with_client(client, base_url, api_key, model, timeout))
    }

    fn with_client(client: reqwest::Client, base_url: &str, api_key: Option<String>, model: &str, timeout: Duration) -> Self {
        Self { client, base_url: base_url.trim_end_matches('/').to_string(), api_key, model: model.to_string(), timeout }
    }

    /// Share the embedder's client, base URL and bearer.
    pub fn from_embedder(e: &RemoteEmbedder, model: &str, timeout: Duration) -> Self {
        Self::with_client(e.client.clone(), &e.base_url, e.api_key.clone(), model, timeout)
    }

    /// Build from the environment (see module docs).
    pub fn from_env() -> Result<Self> {
        let e = RemoteEmbedder::from_env("")?;
        let model = env_nonempty("CCC_RERANK_MODEL").unwrap_or_else(|| DEFAULT_MODEL.into());
        let secs = match env_nonempty("CCC_RERANK_TIMEOUT_S") {
            Some(v) => v.parse().map_err(|_| anyhow!("CCC_RERANK_TIMEOUT_S={v:?} is not a number"))?,
            None => DEFAULT_TIMEOUT_S,
        };
        Ok(Self::from_embedder(&e, &model, Duration::from_secs(secs)))
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub(crate) fn body(&self, query: &str, documents: &[String], top_k: Option<usize>) -> Value {
        let wire_model = self.model.strip_prefix(VOYAGE_PREFIX).unwrap_or(&self.model);
        let mut body = json!({ "query": query, "documents": documents, "model": wire_model });
        if let Some(k) = top_k {
            body["top_k"] = json!(k);
        }
        body
    }

    /// Rerank `documents` for `query`. `top_k` of `None` or `Some(0)` asks for
    /// every document back. Never errors: see `RerankOutcome`.
    pub async fn rerank(&self, query: &str, documents: &[String], top_k: Option<usize>) -> RerankOutcome {
        use RerankOutcome::Fallback as Fb;
        let top_k = top_k.filter(|&k| k > 0);
        if documents.is_empty() {
            return RerankOutcome::Reranked(Vec::new());
        }
        let expected = top_k.map_or(documents.len(), |k| k.min(documents.len()));
        let url = format!("{}/rerank", self.base_url);
        let mut req = self.client.post(&url).timeout(self.timeout).json(&self.body(query, documents, top_k));
        if let Some(key) = &self.api_key {
            req = req.bearer_auth(key);
        }
        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) if e.is_timeout() => return Fb(Fallback::Timeout),
            Err(e) => return Fb(Fallback::Transport(e.without_url().to_string())),
        };
        let status = resp.status();
        if !status.is_success() {
            return Fb(Fallback::Http(status.as_u16()));
        }
        let body: Value = match resp.json().await {
            Ok(v) => v,
            Err(e) if e.is_timeout() => return Fb(Fallback::Timeout),
            Err(e) => return Fb(Fallback::Malformed(format!("response decode failed: {}", e.without_url()))),
        };
        match parse_ranked(&body, documents.len(), expected) {
            Ok(ranked) => RerankOutcome::Reranked(ranked),
            Err(why) => Fb(Fallback::Malformed(why)),
        }
    }
}

/// Validate a rerank response: `data` holds exactly `expected` entries, each
/// with a distinct integer `index < n` and a finite `relevance_score`.
pub(crate) fn parse_ranked(body: &Value, n: usize, expected: usize) -> Result<Vec<Ranked>, String> {
    let data = body.get("data").and_then(Value::as_array).ok_or("response has no data array")?;
    if data.len() != expected {
        return Err(format!("{} results for {expected} expected", data.len()));
    }
    let mut seen = vec![false; n];
    data.iter()
        .map(|d| {
            let raw = d.get("index").unwrap_or(&Value::Null);
            let index = raw.as_u64().ok_or_else(|| format!("malformed index {raw}"))? as usize;
            let slot = seen.get_mut(index).ok_or_else(|| format!("index {index} out of range for {n} documents"))?;
            if std::mem::replace(slot, true) {
                return Err(format!("index {index} returned twice"));
            }
            let score = d
                .get("relevance_score")
                .and_then(Value::as_f64)
                .filter(|s| s.is_finite())
                .ok_or_else(|| format!("malformed relevance_score for index {index}"))?;
            Ok(Ranked { index, score })
        })
        .collect()
}

#[cfg(test)]
#[path = "rerank_tests.rs"]
mod tests;
