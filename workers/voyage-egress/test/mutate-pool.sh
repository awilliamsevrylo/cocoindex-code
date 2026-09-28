#!/usr/bin/env bash
# Mutation check for the shared pool: give rerank.ts its OWN SlotScheduler and
# its OWN cooldown map again (the finding this suite exists for) and require
# test/pool.test.ts to go RED. Restores src/rerank.ts on exit no matter what.
# Exit 0 = the suite has teeth; exit 1 = it does not.
set -uo pipefail
cd "$(dirname "$0")/.."
SRC=src/rerank.ts
BAK=$(mktemp)
cp "$SRC" "$BAK"
trap 'cp "$BAK" "$SRC"; rm -f "$BAK"' EXIT

OUT=$(mktemp)
run() {
  node --test --test-reporter=tap --experimental-strip-types test/pool.test.ts > "$1" 2>&1
  grep -E '^# (pass|fail) ' "$1" | tr '\n' ' '
}

echo "baseline: $(run "$OUT")"
base_fail=$(grep -E '^# fail ' "$OUT" | awk '{print $3}')
if [ "${base_fail:-1}" -ne 0 ]; then
  echo "baseline is not green (fail=$base_fail) — refusing to judge the mutant"
  exit 2
fi

perl -0pi -e "s/import \{ NoHealthySlot \} from '\.\/scheduler\.ts';/import { NoHealthySlot, SlotScheduler } from '.\/scheduler.ts';/; s/const \{ scheduler, cooldownUntil \} = sharedPool\(\);/const cooldownUntil = new Map<number, number>();\nconst scheduler = new SlotScheduler(2);/" "$SRC"

if ! grep -q 'new SlotScheduler(2)' "$SRC"; then echo "MUTANT per-route-pool: NOT APPLIED"; exit 3; fi
if grep -q 'sharedPool()' "$SRC"; then echo "MUTANT per-route-pool: NOT APPLIED (still calls sharedPool)"; exit 3; fi

echo "mutant (rerank has its own scheduler + cooldown map): $(run "$OUT")"
f=$(grep -E '^# fail ' "$OUT" | awk '{print $3}')
echo "killed: $(grep -cE '^not ok' "$OUT") -> $(grep -E '^not ok' "$OUT" | head -3 | sed 's/^not ok [0-9]* - //' | tr '\n' ';')"
rm -f "$OUT"
[ "${f:-0}" -gt 0 ]