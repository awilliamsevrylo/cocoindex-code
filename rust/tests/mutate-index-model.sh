#!/usr/bin/env bash
# Mutation teeth for src/index_model.rs: each mutant must kill >=1 test.
set -uo pipefail
cd "$(dirname "$0")/.."
F=src/index_model.rs
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
  out=$(cargo test index_model 2>&1)
  died=$(printf '%s\n' "$out" | /usr/bin/grep -E '^test .* FAILED$' | /usr/bin/sed 's/^test //; s/ \.\.\. FAILED$//' | tr '\n' ' ')
  if [ -n "$died" ]; then echo "KILLED $1 -> $died"; else echo "SURVIVED $1"; survivors=$((survivors+1)); fi
}

run_mutant drop-mismatch-check 's/if m.model != configured {/if false {/'
run_mutant override-ignored 's/let model = ov.model.clone().unwrap_or_else(|| global.model.clone());/let model = global.model.clone();/'
run_mutant leak-global-params 's/        if same {/        if true {/'
run_mutant legacy-refused 's/        return Ok(None);/        bail!("no meta");/'

echo "survivors=$survivors"
exit $survivors
