#!/usr/bin/env bash
# Mutation check for the HTTP parser tests: break chunk reassembly (keep only
# the first chunk) and require at least one test to fail. Restores the file on
# exit no matter what. Exit 0 = the suite has teeth; exit 1 = it does not.
set -uo pipefail
cd "$(dirname "$0")/.."
SRC=src/rawhttp-parse.ts
BAK=$(mktemp)
cp "$SRC" "$BAK"
trap 'cp "$BAK" "$SRC"; rm -f "$BAK"' EXIT

run() {
  node --test --test-reporter=tap --experimental-strip-types test/rawhttp.test.ts > "$1" 2>&1
  grep -E '^# (pass|fail) ' "$1" | tr '\n' ' '
}

OUT=$(mktemp)
echo "baseline: $(run "$OUT")"
base_fail=$(grep -E '^# fail ' "$OUT" | awk '{print $3}')

perl -0pi -e 's/out\.push\(data\.subarray\(start, start \+ size\)\);/if (out.length < 1) out.push(data.subarray(start, start + size));/' "$SRC"
if ! grep -q 'out.length < 1' "$SRC"; then echo "MUTATION NOT APPLIED"; exit 2; fi
echo "mutant:   $(run "$OUT")"
mut_fail=$(grep -E '^# fail ' "$OUT" | awk '{print $3}')
grep -E '^not ok' "$OUT" | sed 's/^/  died: /'

if [ "${base_fail:-x}" = "0" ] && [ "${mut_fail:-0}" -gt 0 ]; then
  echo "TEETH: OK"
  exit 0
fi
echo "TEETH: NONE"
exit 1
