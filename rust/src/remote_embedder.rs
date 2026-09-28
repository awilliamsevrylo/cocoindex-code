//! Remote embedder for `provider: litellm` configs. Posts an OpenAI-compatible
//! `POST {base}/embeddings` body of `{model, input, ...params}`.
//!
//! The engine's `ApiEmbedder` only sends `{model, input}`, so Voyage's
//! `input_type` (document vs query) could not reach the server. Here the
//! resolved `indexing_params` / `query_params` are merged into the body, which
//! is what the Python litellm provider does with its kwargs.
//!
//! Endpoint and credential come from the environment (the daemon exports the
//! global settings `envs:` block before building the embedder):
//! - `CCC_EMBED_BASE_URL` — default `https://api.voyageai.com/v1`. Point it at
//!   the voyage-egress Worker (`https://…/v1`) for the pinned-IP key pool.
//! - bearer: `CCC_EMBED_API_KEY_FILE` (path), else `CCC_EMBED_API_KEY`, else
//!   `VOYAGE_API_KEY`. The key is never included in errors or logs.
//! - `CCC_EMBED_MAX_INFLIGHT` — cap on concurrent HTTP requests (default 16).
//!   The indexer fans out one call per file with no limit of its own, so
//!   this is the only thing standing between a big corpus and a request storm.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{OnceCell, Semaphore};

use crate::embedder_params::Params;

const DEFAULT_BASE_URL: &str = "https://api.voyageai.com/v1";
/// litellm-style provider prefix; Voyage (and the Worker) take the bare id.
const VOYAGE_PREFIX: &str = "voyage/";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
pub const DEFAULT_MAX_INFLIGHT: usize = 16;

#[derive(Clone)]
pub struct RemoteEmbedder {
    client: reqwest::Client,
    base_url: String,
    /// Model id as configured (identity for change detection).
    model: String,
    api_key: Option<String>,
    dimension: Arc<OnceCell<usize>>,
    /// Shared by every clone, so the cap holds across all concurrent files.
    inflight: Arc<Semaphore>,
}

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

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn resolve_api_key() -> Result<Option<String>> {
    if let Some(path) = env_nonempty("CCC_EMBED_API_KEY_FILE") {
        let key = std::fs::read_to_string(&path)
            .map_err(|e| anyhow!("reading CCC_EMBED_API_KEY_FILE {path}: {e}"))?;
        let key = key.trim().to_string();
        if key.is_empty() {
            bail!("CCC_EMBED_API_KEY_FILE {path} is empty");
        }
        return Ok(Some(key));
    }
    Ok(env_nonempty("CCC_EMBED_API_KEY").or_else(|| env_nonempty("VOYAGE_API_KEY")))
}

impl RemoteEmbedder {
    pub fn new(model: &str, base_url: &str, api_key: Option<String>) -> Result<Self> {
        Self::with_max_inflight(model, base_url, api_key, DEFAULT_MAX_INFLIGHT)
    }

    pub fn with_max_inflight(
        model: &str,
        base_url: &str,
        api_key: Option<String>,
        max_inflight: usize,
    ) -> Result<Self> {
        if max_inflight == 0 {
            bail!("CCC_EMBED_MAX_INFLIGHT must be at least 1");
        }
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| anyhow!("building HTTP client: {e}"))?;
        Ok(Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            model: model.to_string(),
            api_key,
            dimension: Arc::new(OnceCell::new()),
            inflight: Arc::new(Semaphore::new(max_inflight)),
        })
    }

    /// Build from the environment (see module docs).
    pub fn from_env(model: &str) -> Result<Self> {
        let base = env_nonempty("CCC_EMBED_BASE_URL").unwrap_or_else(|| DEFAULT_BASE_URL.into());
        let cap = match env_nonempty("CCC_EMBED_MAX_INFLIGHT") {
            Some(v) => v.parse().map_err(|_| anyhow!("CCC_EMBED_MAX_INFLIGHT={v:?} is not a number"))?,
            None => DEFAULT_MAX_INFLIGHT,
        };
        Self::with_max_inflight(model, &base, resolve_api_key()?, cap)
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    /// Request body: params first, then `model`/`input` so a stray param can
    /// never override what is being embedded.
    pub(crate) fn body(&self, texts: &[String], params: &Params) -> Value {
        let mut body = Value::Object(params.clone());
        let wire_model = self.model.strip_prefix(VOYAGE_PREFIX).unwrap_or(&self.model);
        body["model"] = json!(wire_model);
        body["input"] = json!(texts);
        body
    }

    pub async fn embed_batch(&self, texts: Vec<String>, params: &Params) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let url = format!("{}/embeddings", self.base_url);
        // Held until the response body is read: the slot is busy until then.
        let _permit = self.inflight.acquire().await.map_err(|_| anyhow!("embedder closed"))?;
        let mut req = self.client.post(&url).json(&self.body(&texts, params));
        if let Some(key) = &self.api_key {
            req = req.bearer_auth(key);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| anyhow!("embedding request to {url} failed: {}", e.without_url()))?;
        let status = resp.status();
        if !status.is_success() {
            let mut text = resp.text().await.unwrap_or_default();
            text.truncate(400);
            bail!("embedding request to {url} failed ({status}): {text}");
        }
        let parsed: EmbeddingResponse = resp
            .json()
            .await
            .map_err(|e| anyhow!("embedding response decode failed: {e}"))?;
        order_vectors(parsed.data, texts.len())
    }

    /// Embedding dimension, probed once with `probe_params` and cached.
    pub async fn dimension(&self, probe_params: &Params) -> Result<usize> {
        let dim = self
            .dimension
            .get_or_try_init(|| async {
                let v = self.embed_batch(vec!["hello".into()], probe_params).await?;
                v.first().map(|e| e.len()).ok_or_else(|| anyhow!("embedding API returned no vectors"))
            })
            .await?;
        Ok(*dim)
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

#[cfg(test)]
#[path = "remote_embedder_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "remote_embedder_cap_tests.rs"]
mod cap_tests;
