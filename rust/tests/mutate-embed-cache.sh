#!/usr/bin/env bash
# Mutation teeth for the vector cache (embed_cache.rs, cached_embed.rs,
# single_flight.rs). Each mutant must kill >=1 test. Restores + touches.
set -uo pipefail
cd "$(dirname "$0")/.."
FILES=(src/embed_cache.rs src/cached_embed.rs src/single_flight.rs)
BAK=$(mktemp -d); cp "${FILES[@]}" "$BAK/"
trap 'cp "$BAK"/*.rs src/; touch "${FILES[@]}"; rm -rf "$BAK"' EXIT
export PATH="$HOME/.cargo/bin:/usr/bin:/bin"
survivors=0

run_mutant() { # name, file, sed expression
  cp "$BAK"/*.rs src/; touch "${FILES[@]}"
  /usr/bin/sed -i '' "$3" "$2"
  if cmp -s "$2" "$BAK/$(basename "$2")"; then echo "MUTANT $1: sed did not apply (instrument dead)"; survivors=$((survivors+1)); return; fi
  out=$(cargo test cache 2>&1)
  if printf '%s' "$out" | /usr/bin/grep -q '^error\['; then echo "MUTANT $1: does not compile (instrument dead)"; survivors=$((survivors+1)); return; fi
  died=$(printf '%s\n' "$out" | /usr/bin/grep -E '^test .* FAILED$' | /usr/bin/sed 's/^test //; s/ \.\.\. FAILED$//' | tr '\n' ' ')
  if [ -n "$died" ]; then echo "KILLED $1 -> $died"; else echo "SURVIVED $1"; survivors=$((survivors+1)); fi
}

run_mutant drop-params-from-key src/embed_cache.rs 's/for part in \["v1", model, &params, text\]/for part in ["v1", model, "", text]/'
run_mutant no-length-prefix     src/embed_cache.rs 's/h.update((part.len() as u64).to_le_bytes());/();/'
run_mutant skip-lookup          src/cached_embed.rs 's/let mut out = cache.get_many(&keys).await?;/let mut out: Vec<Option<Vec<f32>>> = vec![None; keys.len()];/'
# No cross-caller waiting: every concurrent caller owns and fetches.
run_mutant no-single-flight     src/single_flight.rs 's/            match map.get(k) {/            match None::<\&Slot> {/'

echo "survivors=$survivors"
exit $survivors
