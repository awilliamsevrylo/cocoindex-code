#!/usr/bin/env bash
# Regenerate the Android docs corpus end to end, then index and gate it.
# Every stage is resumable, so rerunning after a failure (or with --from) only
# pays for unfinished work:
#   urls     node corpus/jobs/android-docs-urls.mjs          (sitemap -> URL list)
#   android  node fanout/cli.mjs run corpus/jobs/android-docs.json
#   aosp     node fanout/cli.mjs run corpus/jobs/aosp-docs.json
#   watch    node fanout/cli.mjs watch <spec>, ONE PER SPEC, run concurrently;
#            the stage fails if either watch exits non-zero
#   assemble bash corpus/assemble.sh                         (Wasabi -> local tree)
#   index    bash rust/tests/poc9-corpus.sh                  (cccrust index + queries)
#   gate     completeness: URL list vs android .md on disk vs files indexed
#            (cccrust status), AOSP items vs AOSP manifest; fails below
#            GATE_MIN_PCT (default 98) with per-source numbers
#
# Usage: bash corpus/regen.sh [--from STAGE] [--to STAGE] [--dry-run] [-- assemble args]
#   --dry-run  print stage commands; assemble runs with --dry-run (listing only),
#              index and gate are skipped
# Env: CORPUS_DEST (default ~/PROJECTS/aosp-docs), CCC_BIN, GATE_MIN_PCT
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STAGES=(urls android aosp watch assemble index gate)
FROM=urls; TO=gate; DRY=0; EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="$2"; shift ;;
    --to) TO="$2"; shift ;;
    --dry-run) DRY=1 ;;
    --) shift; EXTRA=("$@"); break ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
idx() { local i; for i in "${!STAGES[@]}"; do [ "${STAGES[$i]}" = "$1" ] && { echo "$i"; return; }; done; echo -1; }
F=$(idx "$FROM"); T=$(idx "$TO")
[ "$F" -ge 0 ] && [ "$T" -ge "$F" ] || { echo "bad --from/--to (stages: ${STAGES[*]})" >&2; exit 2; }

JOBS=(corpus/jobs/android-docs.json corpus/jobs/aosp-docs.json)
URLS_FILE="${ANDROID_URLS_FILE:-corpus/jobs/android-docs-urls.txt}"
AOSP_ITEMS="${AOSP_ITEMS_FILE:-corpus/jobs/aosp-docs-items.txt}"
URL_BASELINE="${ANDROID_URL_BASELINE:-53925}"
DEST="${CORPUS_DEST:-$HOME/PROJECTS/aosp-docs}"
CCC="${CCC_BIN:-$ROOT/rust/target/release/cccrust}"
MIN_PCT="${GATE_MIN_PCT:-98}"

# Watch every job spec concurrently (each keeps its own lanes alive and healed);
# the stage fails when any watch fails.
watch_all() {
  local pids=() spec rc=0 p
  for spec in "${JOBS[@]}"; do
    ( node fanout/cli.mjs watch "$spec" 2>&1 | sed -u "s|^|[$(basename "$spec" .json)] |"
      exit "${PIPESTATUS[0]}" ) &
    pids+=("$!")
  done
  for p in "${pids[@]}"; do wait "$p" || rc=1; done
  return "$rc"
}

# pct NUM DEN -> integer percent (floor); DEN 0 -> 0
pct() { awk -v n="$1" -v d="$2" 'BEGIN { print (d > 0) ? int(100 * n / d) : 0 }'; }

# End-to-end completeness. Every source must reach MIN_PCT.
gate() {
  local bad=0 urls=0 expected invalid=0 md disk idxd items=0 okitems p
  if [ ! -r "$URLS_FILE" ]; then echo "  FAIL android URL list missing: $URLS_FILE"; bad=1
  else
    urls=$(grep -c '^https://' "$URLS_FILE" || true)
    invalid=$(grep -vc '^https://' "$URLS_FILE" || true)
  fi
  expected=$urls; [ "$expected" -lt "$URL_BASELINE" ] && expected=$URL_BASELINE
  md=$( [ -d "$DEST/android-docs" ] && find "$DEST/android-docs" -type f -name '*.md' | wc -l | tr -d ' ' || echo 0)
  disk=$( [ -d "$DEST" ] && find "$DEST" -type f ! -path '*/.cccrust/*' ! -name MANIFEST.tsv ! -name '.*' | wc -l | tr -d ' ' || echo 0)
  idxd=$( (cd "$DEST" 2>/dev/null && "$CCC" status 2>/dev/null) | grep -oE 'Files: +[0-9]+' | grep -oE '[0-9]+' | head -1)
  if [ ! -r "$AOSP_ITEMS" ]; then echo "  FAIL AOSP item list missing: $AOSP_ITEMS"; bad=1
  else items=$(grep -c . "$AOSP_ITEMS" || true); fi
  okitems=$( [ -f "$DEST/MANIFEST.tsv" ] && awk -F'\t' '$1 == "aosp-docs" && $4 == "ok" {print $3}' "$DEST/MANIFEST.tsv" | sort -u | wc -l | tr -d ' ' || echo 0)
  check() { # label num den
    p=$(pct "$2" "$3")
    if [ "$p" -ge "$MIN_PCT" ]; then echo "  ok   $1: $2/$3 = $p%"; else echo "  FAIL $1: $2/$3 = $p% (< $MIN_PCT%)"; bad=1; fi
  }
  check "android URL list vs baseline" "$urls" "$URL_BASELINE"
  [ "$invalid" -eq 0 ] || { echo "  FAIL android URL list invalid lines: $invalid"; bad=1; }
  check "android md on disk vs expected URLs" "$md" "$expected"
  check "aosp manifest ok items vs item list" "$okitems" "$items"
  if [ -z "$idxd" ]; then echo "  FAIL files indexed: cccrust status unreadable ($CCC in $DEST)"; bad=1
  else check "files indexed vs files on disk" "$idxd" "$disk"; fi
  return "$bad"
}

CMD=()
cmd_for() {
  case "$1" in
    urls) CMD=(node corpus/jobs/android-docs-urls.mjs) ;;
    android) CMD=(node fanout/cli.mjs run "${JOBS[0]}") ;;
    aosp) CMD=(node fanout/cli.mjs run "${JOBS[1]}") ;;
    watch) CMD=(watch_all) ;;
    assemble) CMD=(bash corpus/assemble.sh)
      [ "$DRY" = 1 ] && CMD+=(--dry-run)
      [ "${#EXTRA[@]}" -gt 0 ] && CMD+=("${EXTRA[@]}") ;;
    index) CMD=(bash rust/tests/poc9-corpus.sh) ;;
    gate) CMD=(gate) ;;
  esac
}

for ((i = F; i <= T; i++)); do
  s=${STAGES[$i]}; cmd_for "$s"
  label="${CMD[*]}"
  [ "$s" = watch ] && label="node fanout/cli.mjs watch <spec> for: ${JOBS[*]} (concurrent)"
  [ "$s" = gate ] && label="completeness gate (>= $MIN_PCT% per source)"
  echo "== [$((i + 1))/${#STAGES[@]}] $s: $label"
  if [ "$DRY" = 1 ] && [ "$s" != assemble ]; then echo "   (dry-run: not executed)"; continue; fi
  t0=$(date +%s)
  "${CMD[@]}"; rc=$?
  echo "== $s rc=$rc in $(( $(date +%s) - t0 ))s"
  if [ "$rc" != 0 ]; then
    echo "stopped at '$s'. Fix and resume with: bash corpus/regen.sh --from $s" >&2
    exit "$rc"
  fi
done
echo "regen done (${STAGES[$F]} .. ${STAGES[$T]})"
