#!/usr/bin/env bash
# Mutation teeth for the remote embed path (remote_embedder.rs, http_fetch.rs,
# retry.rs). Each mutant must kill >=1 test. Restores AND touches the files:
# a restore brings back an OLDER mtime and cargo would keep the stale mutant
# build (measured: peak_inflight_equals_cap saw 64, not 8).
set -uo pipefail
cd "$(dirname "$0")/.."
FILES=(src/remote_embedder.rs src/http_fetch.rs src/retry.rs)
BAK=$(mktemp -d); cp "${FILES[@]}" "$BAK/"
trap 'cp "$BAK"/*.rs src/; touch "${FILES[@]}"; rm -rf "$BAK"' EXIT
export PATH="$HOME/.cargo/bin:/usr/bin:/bin"
survivors=0

run_mutant() { # name, file, sed expression
  cp "$BAK"/*.rs src/; touch "${FILES[@]}"
  /usr/bin/sed -i '' "$3" "$2"
  if cmp -s "$2" "$BAK/$(basename "$2")"; then echo "MUTANT $1: sed did not apply (instrument dead)"; survivors=$((survivors+1)); return; fi
  out=$(cargo test 2>&1)
  if printf '%s' "$out" | /usr/bin/grep -q '^error\['; then echo "MUTANT $1: does not compile (instrument dead)"; survivors=$((survivors+1)); return; fi
  died=$(printf '%s\n' "$out" | /usr/bin/grep -E '^test .* FAILED$' | /usr/bin/sed 's/^test //; s/ \.\.\. FAILED$//' | tr '\n' ' ')
  if [ -n "$died" ]; then echo "KILLED $1 -> $died"; else echo "SURVIVED $1"; survivors=$((survivors+1)); fi
}

R=src/remote_embedder.rs; H=src/http_fetch.rs; P=src/retry.rs
run_mutant drop-params-merge     $R 's/let mut body = Value::Object(params.clone());/let mut body = Value::Object(Params::new());/'
run_mutant keep-voyage-prefix    $R 's/strip_prefix(VOYAGE_PREFIX).unwrap_or(&self.model)/as_str()/'
run_mutant ignore-response-index $H 's/let i = d.index.unwrap_or(pos);/let i = pos;/'
run_mutant no-length-check       $H 's/if data.len() != expected {/if false {/'
run_mutant drop-inflight-permit  $H 's/let _permit = e.inflight.acquire().await.map_err(|_| anyhow!("embedder closed"))?;/let _permit = ();/'
run_mutant never-retry           $P 's/        None => retry(),/        None => Action::Fail,/'
run_mutant retry-all-4xx         $P 's/        Some(_) => Action::Fail,/        Some(_) => retry(),/'
run_mutant never-split           $P 's/if batch_len > 1 { Action::Split } else { Action::Fail }/Action::Fail/'
run_mutant ignore-retry-after    $P 's/        return ra.min(CAP);/        let _ = ra;/'

echo "survivors=$survivors"
exit $survivors
