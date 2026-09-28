//! The cached embed path: cache lookup → single-flight claim → one HTTP fetch
//! for the keys this caller owns → write-through → wait for keys another
//! concurrent caller is already fetching.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;

use crate::embed_cache::{EmbedCache, Key, cache_key};
use crate::embedder_params::Params;
use crate::remote_embedder::RemoteEmbedder;
use crate::single_flight::{SingleFlight, wait};

pub async fn embed_cached(
    e: &RemoteEmbedder,
    cache: &EmbedCache,
    flight: &SingleFlight,
    texts: Vec<String>,
    params: &Params,
) -> Result<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let keys: Vec<Key> = texts.iter().map(|t| cache_key(e.model(), params, t)).collect();
    let mut out = cache.get_many(&keys).await?;
    let miss: Vec<Key> = keys.iter().zip(&out).filter(|(_, v)| v.is_none()).map(|(k, _)| *k).collect();
    if miss.is_empty() {
        return Ok(out.into_iter().map(|v| v.expect("hit")).collect());
    }

    let claim = flight.claim(&miss);
    let mut got: HashMap<Key, Arc<Vec<f32>>> = HashMap::new();
    if !claim.owned.is_empty() {
        let owned_texts: Vec<String> = claim
            .owned
            .iter()
            .map(|(k, _)| texts[keys.iter().position(|x| x == k).expect("owned key is ours")].clone())
            .collect();
        let fetched = e.fetch(owned_texts, params).await;
        let fetched = match fetched {
            Ok(v) => v,
            Err(err) => {
                flight.finish(claim.owned, &got); // wake waiters empty-handed
                return Err(err);
            }
        };
        let items: Vec<(Key, &[f32])> =
            claim.owned.iter().map(|(k, _)| *k).zip(fetched.iter().map(|v| v.as_slice())).collect();
        // Write-through is best effort: the vectors are already in hand, so a
        // cache that cannot take them costs the next run a fetch, never this
        // one its results. `put_many` absorbs every write error internally; the
        // one Err it can still return is a PoolTimedOut acquire at the 300s cap
        // (reachable at ~150 concurrent callers against a wedged writer), and
        // that must not surface here either.
        if let Err(err) = cache.put_many(&items).await {
            tracing::warn!("embed cache write-through skipped: {err:#}");
        }
        for ((k, _), v) in claim.owned.iter().zip(fetched) {
            got.insert(*k, Arc::new(v));
        }
        flight.finish(claim.owned, &got);
    }

    // Keys another caller owned: wait; if its fetch failed, fetch ourselves.
    let mut retry = Vec::new();
    for (k, rx) in claim.waiting {
        match wait(rx).await {
            Some(v) => {
                got.insert(k, v);
            }
            None => retry.push(k),
        }
    }
    if !retry.is_empty() {
        let rtexts: Vec<String> =
            retry.iter().map(|k| texts[keys.iter().position(|x| x == k).expect("ours")].clone()).collect();
        let fetched = e.fetch(rtexts, params).await?;
        for (k, v) in retry.into_iter().zip(fetched) {
            got.insert(k, Arc::new(v));
        }
    }

    for (i, slot) in out.iter_mut().enumerate() {
        if slot.is_none() {
            *slot = Some(got.get(&keys[i]).expect("every miss resolved").as_ref().clone());
        }
    }
    Ok(out.into_iter().map(|v| v.expect("filled")).collect())
}

#[cfg(test)]
#[path = "cached_embed_tests.rs"]
mod tests;
