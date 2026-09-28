//! LMDB map size configuration for CocoIndex engine.

/// Default LMDB map size: 64 GiB.
pub const DEFAULT_LMDB_MAP_SIZE: usize = 64 << 30;

/// Environment variable controlling the LMDB map size (in bytes).
pub const ENV_CCCRUST_LMDB_MAP_SIZE: &str = "CCCRUST_LMDB_MAP_SIZE";

/// Returns the LMDB map size in bytes to use for the CocoIndex environment.
///
/// Reads the environment variable `CCCRUST_LMDB_MAP_SIZE`. If it is set, parses as
/// a `usize`, and is greater than 0, that value is returned.
/// Otherwise, falls back to `DEFAULT_LMDB_MAP_SIZE` (64 GiB).
pub fn lmdb_map_size() -> usize {
    parse_lmdb_map_size(std::env::var(ENV_CCCRUST_LMDB_MAP_SIZE).ok().as_deref())
}

/// Parse an optional raw string value into an LMDB map size in bytes.
pub fn parse_lmdb_map_size(val: Option<&str>) -> usize {
    match val {
        Some(s) => match s.trim().parse::<usize>() {
            Ok(v) if v > 0 => v,
            _ => DEFAULT_LMDB_MAP_SIZE,
        },
        None => DEFAULT_LMDB_MAP_SIZE,
    }
}

#[cfg(test)]
#[path = "lmdb_size_tests.rs"]
mod tests;
