//! The default include set, driven through the real matcher (not a string
//! compare): the six file names POC 8 found skipped in the docs corpus.

use std::path::Path;

use cocoindex::FilePathMatcher;

use super::GitignoreAwareMatcher;
use crate::settings::{DEFAULT_EXCLUDED_PATTERNS, DEFAULT_INCLUDED_PATTERNS};

fn defaults(root: &Path) -> GitignoreAwareMatcher {
    let inc: Vec<String> = DEFAULT_INCLUDED_PATTERNS.iter().map(|s| s.to_string()).collect();
    let exc: Vec<String> = DEFAULT_EXCLUDED_PATTERNS.iter().map(|s| s.to_string()).collect();
    GitignoreAwareMatcher::new(root, &inc, &exc).unwrap()
}

#[test]
fn extensionless_readmes_are_included_by_default() {
    let dir = tempfile::tempdir().unwrap();
    let m = defaults(dir.path());
    for name in ["0088/README", "0255/README.git", "0256/README.sita", "0851/README.windows"] {
        assert!(m.is_file_included(Path::new(name)), "{name} should be indexed");
    }
}

#[test]
fn controls_still_hold() {
    let dir = tempfile::tempdir().unwrap();
    let m = defaults(dir.path());
    assert!(m.is_file_included(Path::new("docs/guide.md")), "positive control");
    assert!(!m.is_file_included(Path::new("bin/READMEish")), "no bare prefix match");
    assert!(!m.is_file_included(Path::new("img/logo.png")), "negative control");
}
