#!/usr/bin/env bash
# POC 8: measured throughput on a 1,000-file slice of the real corpus.
# Real Voyage spend. Each arm gets a fresh CCCRUST_DIR (empty cache).
# Usage: bash poc8-throughput.sh [arm ...]   arms: direct w4 w16 w32 (suffix @<model>, e.g. w32@voyage-4)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="${CCC_BIN:-$HERE/../target/release/cccrust}"
CORPUS="${CORPUS:-$HOME/PROJECTS/aosp-docs}"
N="${N:-1000}"
ROOT="${TMPDIR:-/tmp}/ccc_poc8"
WORKER="https://voyage-egress.andrwill1995.workers.dev/v1"
DEFAULT_MODEL="voyage/voyage-4-large"
OUTCSV="$HERE/../../workers/voyage-egress/test/poc8-results.tsv"
ARMS="${*:-direct w4 w16 w32}"

# Deterministic slice: sorted file list, every k-th, copied once.
SLICE="$ROOT/slice"
if [ ! -f "$SLICE/.done" ]; then
  rm -rf "$SLICE"; mkdir -p "$SLICE"
  find "$CORPUS" -type f \( -name '*.md' -o -name '*.rst' -o -name '*.txt' -o -name 'README*' \) | LC_ALL=C sort > "$ROOT/all.txt"
  total=$(wc -l < "$ROOT/all.txt"); k=$(( total / N )); [ "$k" -lt 1 ] && k=1
  awk -v k="$k" -v n="$N" 'NR % k == 0 && c < n {print; c++}' "$ROOT/all.txt" > "$ROOT/slice.txt"
  i=0; while IFS= read -r f; do i=$((i+1)); d="$SLICE/$(printf '%04d' $i)"; mkdir -p "$d"; cp "$f" "$d/"; done < "$ROOT/slice.txt"
  touch "$SLICE/.done"
fi
echo "slice: $(find "$SLICE" -type f ! -name .done | wc -l | tr -d ' ') files, $(du -sh "$SLICE" | cut -f1) from $(wc -l < "$ROOT/all.txt" | tr -d ' ') corpus files"

[ -f "$OUTCSV" ] || printf 'arm\tmodel\tcap\tfiles\tchunks\tsecs\tchunks_per_s\tclient_retries\trc\n' > "$OUTCSV"

run_arm() { # arm base cap tokenfile model
  local arm=$1 base=$2 cap=$3 tok=$4 MODEL=$5
  local H="$ROOT/$arm/home" P="$ROOT/$arm/proj"
  rm -rf "$ROOT/$arm"; mkdir -p "$H"; cp -R "$SLICE" "$P"; rm -f "$P/.done"
  cat > "$H/global_settings.yml" <<EOF
embedding:
  provider: litellm
  model: $MODEL
  indexing_params:
    input_type: document
  query_params:
    input_type: query
envs:
  CCC_EMBED_BASE_URL: $base
  CCC_EMBED_API_KEY_FILE: $tok
  CCC_EMBED_MAX_INFLIGHT: "$cap"
  RUST_LOG: warn
EOF
  export CCCRUST_DIR="$H" CCCRUST_RUNTIME_DIR="$ROOT/$arm/run"
  (cd "$P" && "$BIN" init >/dev/null 2>&1)
  local t0 t1 rc
  t0=$(date +%s)
  (cd "$P" && "$BIN" index > "$ROOT/$arm/index.out" 2>&1); rc=$?
  t1=$(date +%s)
  local st files chunks retries secs cps
  st=$(cd "$P" && "$BIN" status 2>&1)
  files=$(printf '%s' "$st" | grep -oE 'Files: +[0-9]+' | grep -oE '[0-9]+')
  chunks=$(printf '%s' "$st" | grep -oE 'Chunks: [0-9]+' | grep -oE '[0-9]+')
  retries=$(grep -c 'embed retry' "$ROOT/$arm/run/daemon.log" 2>/dev/null)
  "$BIN" daemon stop >/dev/null 2>&1
  secs=$(( t1 - t0 )); [ "$secs" -lt 1 ] && secs=1
  cps=$(awk -v c="${chunks:-0}" -v s="$secs" 'BEGIN{printf "%.1f", c/s}')
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$arm" "${MODEL#voyage/}" "$cap" "${files:-0}" "${chunks:-0}" "$secs" "$cps" "${retries:-0}" "$rc" | tee -a "$OUTCSV"
  [ "$rc" = 0 ] || tail -3 "$ROOT/$arm/index.out"
}

for spec in $ARMS; do
  arm=${spec%@*}; model=$DEFAULT_MODEL
  [ "$spec" != "$arm" ] && model="voyage/${spec#*@}"
  case "$arm" in
    direct)
      # One real key, never printed: first pa- token into a 0600 temp file.
      KEYF="$ROOT/direct.key"; umask 077
      grep -v '^[[:space:]]*#' "$HOME/.drew/voyage.keys" | awk '$1 ~ /^pa-/ {print $1; exit}' > "$KEYF"
      run_arm direct https://api.voyageai.com/v1 1 "$KEYF" "$model"; rm -f "$KEYF" ;;
    w*) run_arm "$spec" "$WORKER" "${arm#w}" "$HOME/.drew/voyage-egress.token" "$model" ;;
  esac
done
