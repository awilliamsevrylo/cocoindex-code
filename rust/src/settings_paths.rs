//! Settings and database paths for cccrust: `~/.cccrust` (global) and
//! `<project>/.cccrust` (per project). Split out of `settings.rs`.

use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const SETTINGS_DIR_NAME: &str = ".cccrust";
const SETTINGS_FILE_NAME: &str = "settings.yml";
const USER_SETTINGS_FILE_NAME: &str = "global_settings.yml";
const TARGET_SQLITE_DB_NAME: &str = "target_sqlite.db";
const COCOINDEX_DB_NAME: &str = "cocoindex.db";

/// Directory for database files. The Python tool supports a db path mapping;
/// that mapping is deferred to Phase 2 (daemon/container).
pub fn resolve_db_dir(project_root: &Path) -> PathBuf {
    project_root.join(SETTINGS_DIR_NAME)
}

pub fn target_sqlite_db_path(project_root: &Path) -> PathBuf {
    resolve_db_dir(project_root).join(TARGET_SQLITE_DB_NAME)
}

pub fn cocoindex_db_path(project_root: &Path) -> PathBuf {
    resolve_db_dir(project_root).join(COCOINDEX_DB_NAME)
}

pub fn user_settings_dir() -> PathBuf {
    if let Ok(override_dir) = std::env::var("CCCRUST_DIR") {
        return PathBuf::from(override_dir);
    }
    dirs::home_dir()
        .map(|h| h.join(SETTINGS_DIR_NAME))
        .unwrap_or_else(|| PathBuf::from(SETTINGS_DIR_NAME))
}

pub fn user_settings_path() -> PathBuf {
    user_settings_dir().join(USER_SETTINGS_FILE_NAME)
}

pub fn project_settings_path(project_root: &Path) -> PathBuf {
    project_root.join(SETTINGS_DIR_NAME).join(SETTINGS_FILE_NAME)
}

/// Walk up from `start` looking for an initialized project (`settings.yml`) or
/// a git repo (`.git/`), stopping at (and excluding) the home directory. Ports
/// `find_parent_with_marker`. Used by `cccrust init` to warn before initializing
/// inside an existing project/repo.
pub fn find_parent_with_marker(start: &Path) -> Option<PathBuf> {
    let home = dirs::home_dir().and_then(|h| std::fs::canonicalize(&h).ok());
    let mut current =
        std::fs::canonicalize(start).unwrap_or_else(|_| start.to_path_buf());
    loop {
        if Some(&current) == home.as_ref() {
            return None;
        }
        // Match Python's order: stop at the filesystem root *before* testing the
        // marker, so a marker at `/` is never returned.
        let Some(parent) = current.parent().filter(|p| *p != current) else {
            return None;
        };
        if current.join(SETTINGS_DIR_NAME).join(SETTINGS_FILE_NAME).is_file()
            || current.join(".git").is_dir()
        {
            return Some(current);
        }
        current = parent.to_path_buf();
    }
}

/// mtime of `global_settings.yml` in integer microseconds, or `None` if absent.
/// The daemon records this at startup; the client compares to detect staleness.
pub fn global_settings_mtime_us() -> Option<i64> {
    let meta = std::fs::metadata(user_settings_path()).ok()?;
    let mtime = meta.modified().ok()?;
    let dur = mtime.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(dur.as_micros() as i64)
}

/// Walk up from `start` looking for `.cccrust/settings.yml`.
pub fn find_project_root(start: &Path) -> Option<PathBuf> {
    // Absolutize like Python's `start.resolve()` so the upward walk reaches the
    // filesystem root even when `start` is relative or doesn't exist.
    let mut current = std::fs::canonicalize(start).unwrap_or_else(|_| {
        if start.is_absolute() {
            start.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|c| c.join(start))
                .unwrap_or_else(|_| start.to_path_buf())
        }
    });
    loop {
        if current.join(SETTINGS_DIR_NAME).join(SETTINGS_FILE_NAME).is_file() {
            return Some(current);
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent.to_path_buf(),
            _ => return None,
        }
    }
}
