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
//! - `CCC_EMBED_CACHE=off` disables the vector cache (`embed_cache.rs`), which
//!   otherwise lives in `~/.cccrust/embed_cache.db`.
//! - `CCC_EMBED_RETRIES` (default 8) / `CCC_EMBED_TIMEOUT_S` (default 120):
//!   see `retry.rs` / `http_fetch.rs` for the fault policy.
//! - `CCC_EMBED_MAX_INFLIGHT` — cap on concurrent HTTP requests (default 32, the POC 8 knee).
//!   The indexer fans out one call per file with no limit of its own, so
//!   this is the only thing standing between a big corpus and a request storm.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};
use tokio::sync::{OnceCell, Semaphore};

use crate::embed_cache::EmbedCache;
use crate::single_flight::SingleFlight;
use crate::embedder_params::Params;

const DEFAULT_BASE_URL: &str = "https://api.voyageai.com/v1";
/// litellm-style provider prefix; Voyage (and the Worker) take the bare id.
const VOYAGE_PREFIX: &str = "voyage/";
const DEFAULT_TIMEOUT_S: u64 = 120;
pub const DEFAULT_MAX_INFLIGHT: usize = 32;

#[derive(Clone)]
pub struct RemoteEmbedder {
    pub(crate) client: reqwest::Client,
    pub(crate) base_url: String,
    /// Model id as configured (identity for change detection).
    model: String,
    pub(crate) api_key: Option<String>,
    dimension: Arc<OnceCell<usize>>,
    /// Shared by every clone, so the cap holds across all concurrent files.
    pub(crate) inflight: Arc<Semaphore>,
    cache: Option<EmbedCache>,
    flight: SingleFlight,
    pub(crate) max_retries: u32,
    pub(crate) timeout: Duration,
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
    #[cfg(test)]
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
            .build()
            .map_err(|e| anyhow!("building HTTP client: {e}"))?;
        Ok(Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            model: model.to_string(),
            api_key,
            dimension: Arc::new(OnceCell::new()),
            inflight: Arc::new(Semaphore::new(max_inflight)),
            cache: None,
            flight: SingleFlight::default(),
            max_retries: crate::retry::DEFAULT_RETRIES,
            timeout: Duration::from_secs(DEFAULT_TIMEOUT_S),
        })
    }

    pub fn with_policy(mut self, max_retries: u32, timeout: Duration) -> Self {
        self.max_retries = max_retries;
        self.timeout = timeout;
        self
    }

    pub fn with_cache(mut self, cache: Option<EmbedCache>) -> Self {
        self.cache = cache;
        self
    }

    /// Build from the environment (see module docs), cache included.
    pub async fn from_env_cached(model: &str) -> Result<Self> {
        let e = Self::from_env(model)?;
        if env_nonempty("CCC_EMBED_CACHE").as_deref() == Some("off") {
            return Ok(e);
        }
        let path = crate::settings::user_settings_dir().join("embed_cache.db");
        Ok(e.with_cache(Some(EmbedCache::open(&path).await?)))
    }

    /// Build from the environment (see module docs), no cache.
    pub fn from_env(model: &str) -> Result<Self> {
        let base = env_nonempty("CCC_EMBED_BASE_URL").unwrap_or_else(|| DEFAULT_BASE_URL.into());
        let cap = match env_nonempty("CCC_EMBED_MAX_INFLIGHT") {
            Some(v) => v.parse().map_err(|_| anyhow!("CCC_EMBED_MAX_INFLIGHT={v:?} is not a number"))?,
            None => DEFAULT_MAX_INFLIGHT,
        };
        let num = |name: &str, default: u64| -> Result<u64> {
            match env_nonempty(name) {
                Some(v) => v.parse().map_err(|_| anyhow!("{name}={v:?} is not a number")),
                None => Ok(default),
            }
        };
        let retries = num("CCC_EMBED_RETRIES", crate::retry::DEFAULT_RETRIES as u64)? as u32;
        let timeout = Duration::from_secs(num("CCC_EMBED_TIMEOUT_S", DEFAULT_TIMEOUT_S)?);
        Ok(Self::with_max_inflight(model, &base, resolve_api_key()?, cap)?.with_policy(retries, timeout))
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

    /// Embed `texts`. With a cache: hits are free; misses are de-duplicated
    /// (within the batch and across concurrent callers) and written through.
    pub async fn embed_batch(&self, texts: Vec<String>, params: &Params) -> Result<Vec<Vec<f32>>> {
        match &self.cache {
            Some(cache) => crate::cached_embed::embed_cached(self, cache, &self.flight, texts, params).await,
            None => self.fetch(texts, params).await,
        }
    }

    /// One logical request (retries, split-on-oversize), no cache.
    pub(crate) async fn fetch(&self, texts: Vec<String>, params: &Params) -> Result<Vec<Vec<f32>>> {
        crate::http_fetch::fetch(self, texts, params).await
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

#[cfg(test)]
#[path = "remote_embedder_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "remote_embedder_cap_tests.rs"]
mod cap_tests;

#[cfg(test)]
#[path = "embed_cache_tests.rs"]
mod cache_tests;
