//! Single-flight for cache misses: when concurrent files need the same chunk
//! (identical content across files), only the first caller fetches it; the
//! rest wait for that result instead of paying for it again. Measured need:
//! 100 identical files indexed concurrently all missed the cache at once and
//! paid 100 times.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::watch;

use crate::embed_cache::Key;

type Slot = watch::Receiver<Option<Arc<Vec<f32>>>>;

#[derive(Clone, Default)]
pub struct SingleFlight {
    pending: Arc<Mutex<HashMap<Key, Slot>>>,
}

/// Keys this caller must fetch (it owns them), and keys someone else is
/// already fetching (wait on them).
pub struct Claim {
    pub owned: Vec<(Key, watch::Sender<Option<Arc<Vec<f32>>>>)>,
    pub waiting: Vec<(Key, Slot)>,
}

impl SingleFlight {
    pub fn claim(&self, keys: &[Key]) -> Claim {
        let mut map = self.pending.lock().expect("single-flight lock");
        let mut claim = Claim { owned: Vec::new(), waiting: Vec::new() };
        for k in keys {
            // A duplicate key in this same batch finds the entry its first
            // copy just inserted and waits on our own fetch — deduped for free.
            match map.get(k) {
                Some(rx) => claim.waiting.push((*k, rx.clone())),
                None => {
                    let (tx, rx) = watch::channel(None);
                    map.insert(*k, rx);
                    claim.owned.push((*k, tx));
                }
            }
        }
        claim
    }

    /// Publish results for owned keys (or drop them on failure) and forget them.
    /// A dropped sender wakes waiters with an error; they fetch for themselves.
    pub fn finish(&self, owned: Vec<(Key, watch::Sender<Option<Arc<Vec<f32>>>>)>, got: &HashMap<Key, Arc<Vec<f32>>>) {
        let mut map = self.pending.lock().expect("single-flight lock");
        for (k, tx) in owned {
            map.remove(&k);
            if let Some(v) = got.get(&k) {
                let _ = tx.send(Some(v.clone()));
            }
        }
    }
}

/// Wait for another caller's fetch. `None` if that fetch failed.
pub async fn wait(mut rx: Slot) -> Option<Arc<Vec<f32>>> {
    loop {
        if let Some(v) = rx.borrow().clone() {
            return Some(v);
        }
        if rx.changed().await.is_err() {
            return rx.borrow().clone();
        }
    }
}
