#!/usr/bin/env bash
# Mutation teeth for src/remote_embedder.rs: each mutant must kill >=1 test.
set -uo pipefail
cd "$(dirname "$0")/.."
F=src/remote_embedder.rs
cp "$F" "$F.orig"
# touch after restore: mv brings back an OLDER mtime and cargo would keep
# the stale mutant build (measured: peak_inflight_equals_cap saw 64, not 8).
trap 'mv "$F.orig" "$F"; touch "$F"' EXIT
export PATH="$HOME/.cargo/bin:/usr/bin:/bin"
survivors=0

run_mutant() { # name, sed expression
  cp "$F.orig" "$F"
  /usr/bin/sed -i '' "$2" "$F"
  if cmp -s "$F" "$F.orig"; then echo "MUTANT $1: sed did not apply (instrument dead)"; survivors=$((survivors+1)); return; fi
  out=$(cargo test remote_embedder 2>&1)
  died=$(printf '%s\n' "$out" | /usr/bin/grep -E '^test .* FAILED$' | /usr/bin/sed 's/^test //; s/ \.\.\. FAILED$//' | tr '\n' ' ')
  if [ -n "$died" ]; then echo "KILLED $1 -> $died"; else echo "SURVIVED $1"; survivors=$((survivors+1)); fi
}

run_mutant drop-params-merge 's/let mut body = Value::Object(params.clone());/let mut body = Value::Object(Params::new());/'
run_mutant ignore-response-index 's/let i = d.index.unwrap_or(pos);/let i = pos;/'
run_mutant no-length-check 's/if data.len() != expected {/if false {/'
run_mutant keep-voyage-prefix 's/strip_prefix(VOYAGE_PREFIX).unwrap_or(&self.model)/as_str()/'
run_mutant drop-inflight-permit 's/let _permit = self.inflight.acquire().await.map_err(|_| anyhow!("embedder closed"))?;/let _permit = ();/'

echo "survivors=$survivors"
exit $survivors
