//! Embedder backend. Ports `shared.create_embedder`.
//!
//! Two providers:
//! - `sentence-transformers`: local fastembed model (in-process).
//! - `litellm`: a remote OpenAI-compatible `/embeddings` endpoint
//!   ([`RemoteEmbedder`]) — Voyage directly, or the voyage-egress Worker that
//!   spreads calls across pinned-IP keys. Only the endpoint shape is shared
//!   with Python's litellm; there is no multi-provider router here.
//!
//! Indexing and query calls carry their own resolved params, so Voyage's
//! `input_type: document|query` from `indexing_params`/`query_params` reaches
//! the wire.

use anyhow::{Result, anyhow, bail};

use crate::embedder_params::Params;
use crate::remote_embedder::RemoteEmbedder;
use crate::settings::EmbeddingSettings;

/// Legacy model-name prefix (`sbert/…`) stripped before loading, matching the
/// Python embedder. Kept for backward compatibility with older configs.
const SBERT_PREFIX: &str = "sbert/";

#[derive(Clone)]
enum Backend {
    Local(cocoindex::ops::sentence_transformers::SentenceTransformerEmbedder),
    Remote(RemoteEmbedder),
}

/// The embedding backend plus the indexing params it was built with.
#[derive(Clone)]
pub struct CodeEmbedder {
    backend: Backend,
    indexing_params: Params,
}

impl CodeEmbedder {
    /// Stable identity for change detection (parity for Python's
    /// `ContextKey(..., detect_change=True)` keyed on the embedder). The
    /// endpoint is deliberately not part of it: the Worker and direct Voyage
    /// return the same vectors for the same model.
    pub fn state_key(&self) -> String {
        match &self.backend {
            Backend::Local(e) => format!("sentence-transformers:{}", e.model_name()),
            Backend::Remote(e) => format!("litellm:{}", e.model()),
        }
    }

    pub async fn embed_batch(&self, texts: Vec<String>, params: &Params) -> Result<Vec<Vec<f32>>> {
        match &self.backend {
            // NOTE: `prompt_name` (query vs passage) is not yet threaded through
            // the SDK's local embedder; tracked as a parity follow-up.
            Backend::Local(e) => {
                e.embed_batch(texts).await.map_err(|e| anyhow!("local embed failed: {e}"))
            }
            Backend::Remote(e) => e.embed_batch(texts, params).await,
        }
    }

    /// Embed chunks for the index, with the configured `indexing_params`.
    pub async fn embed_for_indexing(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        self.embed_batch(texts, &self.indexing_params).await
    }

    pub async fn embed(&self, text: &str, params: &Params) -> Result<Vec<f32>> {
        let mut out = self.embed_batch(vec![text.to_string()], params).await?;
        out.pop().ok_or_else(|| anyhow!("embedder returned no vectors"))
    }

    /// The embedding dimension (exact: from the loaded model, or probed once
    /// against the remote endpoint with the indexing params).
    pub async fn dimension(&self) -> Result<usize> {
        match &self.backend {
            Backend::Local(e) => Ok(e.dimension()),
            Backend::Remote(e) => e.dimension(&self.indexing_params).await,
        }
    }
}

/// Build an embedder from settings.
pub async fn create_embedder(
    settings: &EmbeddingSettings,
    indexing_params: &Params,
) -> Result<CodeEmbedder> {
    let backend = match settings.provider.as_str() {
        "sentence-transformers" => {
            let mut model = settings.model.clone();
            if let Some(stripped) = model.strip_prefix(SBERT_PREFIX) {
                model = stripped.to_string();
            }
            let inner =
                cocoindex::ops::sentence_transformers::SentenceTransformerEmbedder::load(&model)
                    .await
                    .map_err(|e| anyhow!("loading sentence-transformers model {model:?}: {e}"))?;
            Backend::Local(inner)
        }
        "litellm" => Backend::Remote(RemoteEmbedder::from_env_cached(&settings.model).await?),
        other => bail!(
            "Embedding provider '{other}' is not supported by the Rust port. Use \
             `provider: sentence-transformers` (local fastembed) or `provider: litellm` \
             (remote OpenAI-compatible endpoint; set CCC_EMBED_BASE_URL) in {}.",
            crate::settings::user_settings_path().display()
        ),
    };
    Ok(CodeEmbedder { backend, indexing_params: indexing_params.clone() })
}
