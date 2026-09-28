use super::*;
use std::sync::Mutex;

static ENV_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn test_default() {
    let _guard = ENV_LOCK.lock().unwrap();
    unsafe { std::env::remove_var(ENV_CCCRUST_LMDB_MAP_SIZE) };
    assert_eq!(lmdb_map_size(), DEFAULT_LMDB_MAP_SIZE);
    assert_eq!(DEFAULT_LMDB_MAP_SIZE, 64 * 1024 * 1024 * 1024);
}

#[test]
fn test_override() {
    let _guard = ENV_LOCK.lock().unwrap();
    unsafe { std::env::set_var(ENV_CCCRUST_LMDB_MAP_SIZE, "1073741824") };
    assert_eq!(lmdb_map_size(), 1073741824);
    unsafe { std::env::remove_var(ENV_CCCRUST_LMDB_MAP_SIZE) };
}

#[test]
fn test_garbage_fallback() {
    let _guard = ENV_LOCK.lock().unwrap();
    unsafe { std::env::set_var(ENV_CCCRUST_LMDB_MAP_SIZE, "invalid_bytes") };
    assert_eq!(lmdb_map_size(), DEFAULT_LMDB_MAP_SIZE);
    unsafe { std::env::set_var(ENV_CCCRUST_LMDB_MAP_SIZE, "0") };
    assert_eq!(lmdb_map_size(), DEFAULT_LMDB_MAP_SIZE);
    unsafe { std::env::set_var(ENV_CCCRUST_LMDB_MAP_SIZE, "-100") };
    assert_eq!(lmdb_map_size(), DEFAULT_LMDB_MAP_SIZE);
    unsafe { std::env::remove_var(ENV_CCCRUST_LMDB_MAP_SIZE) };
}

#[test]
fn test_parse_lmdb_map_size_unit() {
    assert_eq!(parse_lmdb_map_size(None), DEFAULT_LMDB_MAP_SIZE);
    assert_eq!(parse_lmdb_map_size(Some("  32212254720  ")), 32212254720);
    assert_eq!(parse_lmdb_map_size(Some("garbage")), DEFAULT_LMDB_MAP_SIZE);
    assert_eq!(parse_lmdb_map_size(Some("0")), DEFAULT_LMDB_MAP_SIZE);
    assert_eq!(parse_lmdb_map_size(Some("")), DEFAULT_LMDB_MAP_SIZE);
}
