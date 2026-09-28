//! What to do when an embedding request fails. Pure policy, unit-tested.
//!
//! - throttling / transient server errors / transport errors → retry with
//!   exponential backoff + jitter (honoring Retry-After), bounded;
//! - "batch too large" → split the batch in halves;
//! - any other client error (bad key, bad model) → fail now, loudly.

use std::time::Duration;

pub const DEFAULT_RETRIES: u32 = 8;
const BASE: Duration = Duration::from_millis(250);
const CAP: Duration = Duration::from_secs(60);

#[derive(Debug, PartialEq)]
pub enum Action {
    Retry(Duration),
    Split,
    Fail,
}

/// Body phrases Voyage / OpenAI-compatible servers use for oversize batches.
fn says_too_large(body: &str) -> bool {
    let b = body.to_ascii_lowercase();
    [
        "too many tokens", "too_many_tokens", "max allowed tokens", "token limit",
        "maximum context", "too long", "too large", "max_tokens", "exceeds",
    ]
        .iter()
        .any(|p| b.contains(p))
}

pub fn backoff(attempt: u32, retry_after: Option<Duration>) -> Duration {
    if let Some(ra) = retry_after {
        return ra.min(CAP);
    }
    let exp = BASE.saturating_mul(1u32 << attempt.min(8));
    // Up to +50% jitter so parallel files do not retry in lockstep.
    let jitter = exp.mul_f64(0.5 * rand_unit());
    (exp + jitter).min(CAP)
}

fn rand_unit() -> f64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (nanos % 1000) as f64 / 1000.0
}

/// `status` = None means the request never got a response (connect error,
/// timeout, reset). `batch_len` decides whether splitting can help.
pub fn classify(
    status: Option<u16>,
    body: &str,
    batch_len: usize,
    attempt: u32,
    max_retries: u32,
    retry_after: Option<Duration>,
) -> Action {
    let retry = || {
        if attempt < max_retries { Action::Retry(backoff(attempt, retry_after)) } else { Action::Fail }
    };
    match status {
        None => retry(),
        Some(429) | Some(500) | Some(502) | Some(503) | Some(504) => retry(),
        Some(400) | Some(413) if says_too_large(body) => {
            if batch_len > 1 { Action::Split } else { Action::Fail }
        }
        Some(_) => Action::Fail,
    }
}

/// Parse `Retry-After` given in seconds (fractions allowed).
pub fn parse_retry_after(v: Option<&str>) -> Option<Duration> {
    v.and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|s| s.is_finite() && *s >= 0.0)
        .map(Duration::from_secs_f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(status: Option<u16>, body: &str, n: usize, attempt: u32) -> Action {
        classify(status, body, n, attempt, 3, None)
    }

    #[test]
    fn throttling_and_5xx_and_transport_retry() {
        for s in [Some(429), Some(500), Some(502), Some(503), Some(504), None] {
            assert!(matches!(c(s, "", 4, 0), Action::Retry(_)), "{s:?}");
        }
    }

    #[test]
    fn retries_are_bounded() {
        assert_eq!(c(Some(429), "", 4, 3), Action::Fail);
    }

    #[test]
    fn auth_and_bad_model_fail_immediately() {
        assert_eq!(c(Some(401), "unauthorized", 4, 0), Action::Fail);
        assert_eq!(c(Some(400), "model voyage-x not found", 4, 0), Action::Fail);
        assert_eq!(c(Some(404), "", 4, 0), Action::Fail);
    }

    #[test]
    fn oversize_splits_until_single() {
        assert_eq!(c(Some(400), "Request has too many tokens", 4, 0), Action::Split);
        assert_eq!(c(Some(413), "payload too large", 2, 0), Action::Split);
        assert_eq!(c(Some(400), "too many tokens", 1, 0), Action::Fail);
    }

    /// The exact body Voyage returned in POC 8's direct arm (2026-09-28).
    /// Before this test the client failed it after 1 attempt instead of splitting.
    #[test]
    fn real_voyage_batch_token_limit_splits() {
        let body = r#"{"detail":"Request to model 'voyage-4-large' failed. The max allowed tokens per submitted batch is 120000. Your batch has 126899 tokens after truncation. Please lower the number of tokens in the batch.","error_code":"TOO_MANY_TOKENS_IN_BATCH"}"#;
        assert_eq!(c(Some(400), body, 360, 0), Action::Split);
    }

    #[test]
    fn retry_after_is_honored_and_capped() {
        assert_eq!(backoff(0, Some(Duration::from_millis(200))), Duration::from_millis(200));
        assert_eq!(backoff(0, Some(Duration::from_secs(600))), CAP);
        assert_eq!(parse_retry_after(Some("0.2")), Some(Duration::from_millis(200)));
        assert_eq!(parse_retry_after(Some("soon")), None);
    }

    #[test]
    fn backoff_grows_and_stays_capped() {
        assert!(backoff(0, None) < Duration::from_millis(400));
        assert!(backoff(3, None) >= Duration::from_secs(2));
        assert!(backoff(30, None) <= CAP);
    }
}
