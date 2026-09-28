#!/usr/bin/env bash
# POC 9: index the Android docs corpus with cccrust (voyage-4 per-index model)
# and spot-check known-positive queries. Re-runnable after every corpus pull:
# the second run should only pay for new files.
# Usage: bash poc9-corpus.sh [--skip-index]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="${CCC_BIN:-$HERE/../target/release/cccrust}"
CORPUS="${CORPUS:-$HOME/PROJECTS/aosp-docs}"
MODEL="${POC9_MODEL:-voyage/voyage-4}"
QUERIES="$HERE/poc9-queries.tsv"
OUT="${POC9_OUT:-$HERE/../../workers/voyage-egress/test/poc9-results.tsv}"
TOPK=5
fail=0
pass() { echo "  ✅ $*"; }
bad() { echo "  ❌ $*"; fail=1; }

echo "🔎 POC 9: Android docs corpus via cccrust ($MODEL)"
cd "$CORPUS" || { echo "no corpus at $CORPUS"; exit 1; }
nfiles=$(find . -type f ! -path './.cccrust/*' | wc -l | tr -d ' ')
echo "  corpus: $nfiles files"

# Instrument first: every expected path must exist, or a miss means nothing.
missing=0
while IFS=$'\t' read -r q want; do
  [ "$q" = query ] && continue
  find . -path "*$want" -type f | grep -q . || { echo "  missing on disk: $want"; missing=1; }
done < "$QUERIES"
[ "$missing" = 0 ] && pass "all expected files exist on disk" || bad "query set references absent files"

if [ "${1:-}" != --skip-index ]; then
  [ -d .cccrust ] || "$BIN" init --index-model "$MODEL" >/dev/null
  t0=$(date +%s)
  "$BIN" index > "${TMPDIR:-/tmp}/poc9-index.out" 2>&1; rc=$?
  secs=$(( $(date +%s) - t0 ))
  [ "$rc" = 0 ] && pass "index rc 0 in ${secs}s" || { bad "index rc $rc"; tail -5 "${TMPDIR:-/tmp}/poc9-index.out"; }
fi

st=$("$BIN" status 2>&1)
files=$(printf '%s' "$st" | grep -oE 'Files: +[0-9]+' | grep -oE '[0-9]+')
chunks=$(printf '%s' "$st" | grep -oE 'Chunks: [0-9]+' | grep -oE '[0-9]+')
echo "  indexed: files=${files:-?} chunks=${chunks:-?}"
printf '%s' "$st" | grep -q "$MODEL" && pass "index model is $MODEL" || bad "status does not report $MODEL"

hits=0; total=0; posfiles=""
while IFS=$'\t' read -r q want; do
  [ "$q" = query ] && continue
  total=$((total + 1))
  res=$("$BIN" search --limit "$TOPK" $q 2>&1)
  posfiles="$posfiles $want"
  if printf '%s' "$res" | grep -qF "$want"; then hits=$((hits + 1)); echo "  hit  : $want"
  else echo "  MISS : $want"; printf '%s\n' "$res" | grep -oE '[^ ]+\.(md|rst|txt)|README[^ ]*' | head -3 | sed 's/^/         got /'; fi
done < "$QUERIES"
[ "$hits" -ge $((total - 1)) ] && pass "known positives in top $TOPK: $hits/$total" || bad "known positives $hits/$total"

neg=$("$BIN" search --limit "$TOPK" zxqv quokka tax harmonization treaty 2>&1)
leak=0; for w in $posfiles; do printf '%s' "$neg" | grep -qF "$w" && leak=1; done
[ "$leak" = 0 ] && pass "negative control returns none of the positives" || bad "negative control matched a positive"

[ -f "$OUT" ] || printf 'when\tmodel\tcorpus_files\tfiles\tchunks\tsecs\thits\trc\n' > "$OUT"
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s/%s\t%s\n' "$(date -u +%FT%TZ)" "$MODEL" "$nfiles" "${files:-0}" "${chunks:-0}" "${secs:-0}" "$hits" "$total" "${rc:-skip}" >> "$OUT"
[ "$fail" = 0 ] && echo "✅ POC 9: PASS" || echo "❌ POC 9: FAIL"
exit "$fail"
