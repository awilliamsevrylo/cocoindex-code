//! YAML settings schema, loading, saving, and path helpers. Ports
//! `settings.py`.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Default file patterns
// ---------------------------------------------------------------------------

pub const DEFAULT_INCLUDED_PATTERNS: &[&str] = &[
    "**/*.py", "**/*.pyi", "**/*.js", "**/*.jsx", "**/*.ts", "**/*.tsx", "**/*.mjs", "**/*.cjs",
    "**/*.rs", "**/*.go", "**/*.java", "**/*.c", "**/*.h", "**/*.cpp", "**/*.hpp", "**/*.cc",
    "**/*.cxx", "**/*.hxx", "**/*.hh", "**/*.cs", "**/*.sql", "**/*.sh", "**/*.bash", "**/*.zsh",
    "**/*.md", "**/*.mdx", "**/*.txt", "**/*.rst", "**/*.php", "**/*.lua", "**/*.rb", "**/*.swift",
    "**/*.kt", "**/*.kts", "**/*.scala", "**/*.r", "**/*.html", "**/*.htm", "**/*.svelte",
    "**/*.vue", "**/*.css", "**/*.scss", "**/*.json", "**/*.xml", "**/*.yaml", "**/*.yml",
    "**/*.toml", "**/*.sol", "**/*.pas", "**/*.dpr", "**/*.dtd", "**/*.f", "**/*.f90", "**/*.f95",
    "**/*.f03",
    // Extensionless / odd-suffix docs (README, README.git, README.windows):
    // POC 8 found 6 of 1,000 corpus files silently skipped without these.
    "**/README", "**/README.*",
];

pub const DEFAULT_EXCLUDED_PATTERNS: &[&str] = &[
    "**/.*",
    "**/__pycache__",
    "**/node_modules",
    "**/target",
    "**/build/assets",
    "**/dist",
    "**/vendor/*.*/*",
    "**/vendor/*",
    "**/.cccrust",
];

// Python defaults to `Snowflake/snowflake-arctic-embed-xs`, but fastembed's
// model registry does not include it. We default to a small, high-quality
// retrieval model that fastembed ships (resolved by suffix to
// `Xenova/bge-small-en-v1.5`).
pub const DEFAULT_ST_MODEL: &str = "BAAI/bge-small-en-v1.5";

// ---------------------------------------------------------------------------
// Dataclasses
// ---------------------------------------------------------------------------

fn default_provider() -> String {
    "litellm".to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EmbeddingSettings {
    pub model: String,
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_interval_ms: Option<i64>,
    /// Outer `None` = key absent; `Some(None)` = key present but null;
    /// `Some(Some(map))` = key present with a value. This three-state encoding
    /// mirrors Python's `None` (absent) vs `{}` (present-but-empty/null), which
    /// the legacy-bridge opt-out depends on. See [`resolve_embedder_params`].
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub indexing_params: Option<Option<serde_json::Map<String, serde_json::Value>>>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub query_params: Option<Option<serde_json::Map<String, serde_json::Value>>>,
}

/// Deserialize so a *present* key (even `null`) becomes `Some(...)`, while an
/// *absent* key stays `None` (via `#[serde(default)]`). Standard serde collapses
/// a present-null into `None`; this preserves the distinction.
fn double_option<'de, D, T>(de: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    serde::Deserialize::deserialize(de).map(Some)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UserSettings {
    pub embedding: EmbeddingSettings,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub envs: std::collections::BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LanguageOverride {
    /// Extension without the dot, e.g. "inc".
    pub ext: String,
    /// Language name, e.g. "php".
    pub lang: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChunkerMapping {
    pub ext: String,
    /// "module.path:callable" — retained for config compatibility. Custom
    /// Python chunkers are not loadable from Rust; see `chunking.rs`.
    pub module: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectSettings {
    #[serde(default = "default_included")]
    pub include_patterns: Vec<String>,
    #[serde(default = "default_excluded")]
    pub exclude_patterns: Vec<String>,
    #[serde(default)]
    pub language_overrides: Vec<LanguageOverride>,
    #[serde(default)]
    pub chunkers: Vec<ChunkerMapping>,
    /// Per-index embedding override (provider/model/params); absent keys
    /// inherit the global settings. See `index_model.rs`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding: Option<crate::index_model::ProjectEmbedding>,
}

fn default_included() -> Vec<String> {
    DEFAULT_INCLUDED_PATTERNS.iter().map(|s| s.to_string()).collect()
}
fn default_excluded() -> Vec<String> {
    DEFAULT_EXCLUDED_PATTERNS.iter().map(|s| s.to_string()).collect()
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            include_patterns: default_included(),
            exclude_patterns: default_excluded(),
            language_overrides: Vec::new(),
            chunkers: Vec::new(),
            embedding: None,
        }
    }
}

pub fn default_user_settings() -> UserSettings {
    UserSettings {
        embedding: EmbeddingSettings {
            provider: "sentence-transformers".to_string(),
            model: DEFAULT_ST_MODEL.to_string(),
            device: None,
            min_interval_ms: None,
            indexing_params: None,
            query_params: None,
        },
        envs: Default::default(),
    }
}

// Path helpers live in settings_paths.rs (re-exported so callers are unchanged).
pub use crate::settings_paths::*;

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

pub fn load_user_settings() -> Result<UserSettings> {
    let path = user_settings_path();
    if !path.is_file() {
        bail!("User settings not found: {}", path.display());
    }
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("reading {}", path.display()))?;
    if text.trim().is_empty() {
        bail!("Error loading {}: File is empty", path.display());
    }
    let settings: UserSettings = serde_yaml::from_str(&text)
        .with_context(|| format!("parsing {}", path.display()))?;
    Ok(settings)
}

pub fn save_user_settings(settings: &UserSettings) -> Result<PathBuf> {
    let path = user_settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let yaml = serde_yaml::to_string(settings)?;
    std::fs::write(&path, yaml)?;
    Ok(path)
}

pub fn load_project_settings(project_root: &Path) -> Result<ProjectSettings> {
    let path = project_settings_path(project_root);
    if !path.is_file() {
        bail!("Project settings not found: {}", path.display());
    }
    let text = std::fs::read_to_string(&path)?;
    if text.trim().is_empty() {
        return Ok(ProjectSettings::default());
    }
    let settings: ProjectSettings = serde_yaml::from_str(&text)
        .with_context(|| format!("parsing {}", path.display()))?;
    Ok(settings)
}

pub fn save_project_settings(project_root: &Path, settings: &ProjectSettings) -> Result<PathBuf> {
    let path = project_settings_path(project_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let yaml = serde_yaml::to_string(settings)?;
    std::fs::write(&path, yaml)?;
    Ok(path)
}
