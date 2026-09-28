#!/usr/bin/env bash
# Mutation checks for the dispatch core. Each mutant must kill >=1 test.
# Restores src/dispatch.ts on exit. Exit 0 only if every mutant is killed.
set -uo pipefail
cd "$(dirname "$0")/.."
SRC=src/dispatch.ts
BAK=$(mktemp); cp "$SRC" "$BAK"
trap 'cp "$BAK" "$SRC"; rm -f "$BAK"' EXIT
OUT=$(mktemp)
survivors=0

mutant() { # name, perl-substitution, marker-grep
  cp "$BAK" "$SRC"
  perl -0pi -e "$2" "$SRC"
  if ! grep -q "$3" "$SRC"; then echo "MUTANT $1: NOT APPLIED"; survivors=$((survivors+1)); return; fi
  node --test --test-reporter=tap --experimental-strip-types test/dispatch.test.ts > "$OUT" 2>&1
  f=$(grep -E '^# fail ' "$OUT" | awk '{print $3}')
  if [ "${f:-0}" -gt 0 ]; then
    echo "MUTANT $1: killed ($f) -> $(grep -E '^not ok' "$OUT" | head -2 | sed 's/^not ok [0-9]* - //' | tr '\n' ';')"
  else
    echo "MUTANT $1: SURVIVED"; survivors=$((survivors+1))
  fi
}

mutant order    's/idx\.forEach\(\(i, j\) => \(out\[i\] = r\.vectors!\[j\]\)\);/idx.forEach((i, j) => (out[i] = r.vectors![idx.length - 1 - j]));/' 'idx.length - 1 - j'
mutant budget   's/curTokens \+ t > maxTokens/curTokens + t > maxTokens * 100/' 'maxTokens \* 100'
mutant reroute  's/if \(r\.status === 429 \|\| r\.status >= 500\) \{/if (false) {/' 'if (false) {'
mutant cooldown 's/cooldownUntil\.set\(slot, now\(\) \+ \(r\.retry_after_ms \?\? 30_000\)\);/void 0;/' 'void 0;'

echo "survivors=$survivors"
[ "$survivors" = "0" ]
