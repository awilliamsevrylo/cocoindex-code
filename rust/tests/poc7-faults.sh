#!/usr/bin/env bash
# POC 7 witness: cccrust survives 429 storms, oversize rejections and stalls;
# fails fast on a hard 4xx; ledger stays consistent; the key never leaks.
# Local fault-injecting mock, zero Voyage spend.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="${CCC_BIN:-$HERE/../target/debug/cccrust}"
NODE="${NODE:-$(command -v node)}"
ROOT="${TMPDIR:-/tmp}/ccc_poc7"
SECRET="poc7-secret-$RANDOM$RANDOM$RANDOM"
fail=0; LOGS=""
check() { if [ "$2" = "1" ]; then echo "PASS $1: $3"; else echo "FAIL $1: $3"; fail=1; fi; }
rm -rf "$ROOT"; mkdir -p "$ROOT"; printf '%s\n' "$SECRET" > "$ROOT/token"; chmod 600 "$ROOT/token"

MOCK=""
start_mock() { # env assignments for the fault mode
  [ -n "$MOCK" ] && { kill "$MOCK" 2>/dev/null; wait "$MOCK" 2>/dev/null; }
  rm -f "$ROOT/port"
  env "$@" "$NODE" "$HERE/mock-embeddings.mjs" "$ROOT/port" 16 20 & MOCK=$!
  for _ in $(seq 1 50); do [ -s "$ROOT/port" ] && break; sleep 0.1; done
  PORT=$(cat "$ROOT/port")
}
trap '[ -n "$MOCK" ] && kill $MOCK 2>/dev/null; "$BIN" daemon stop >/dev/null 2>&1' EXIT
stat() { /usr/bin/curl -s "http://127.0.0.1:$PORT/stats" | jq ".$1"; }

setup() { # label files paragraphs-per-file [extra env lines...]
  local label=$1 files=$2 paras=$3; shift 3
  H="$ROOT/$label/home"; P="$ROOT/$label/proj"; mkdir -p "$H" "$P/docs"
  for i in $(seq 1 "$files"); do
    for j in $(seq 1 "$paras"); do
      printf '## Section %s.%s\n\n%s\n\n' "$i" "$j" "$(printf 'Paragraph %s-%s explains topic %s in detail. ' $(seq 1 18 | sed "s/.*/$i $j &/"))"
    done > "$P/docs/doc$i.md"
  done
  { printf 'embedding:\n  provider: litellm\n  model: mock-embed\nenvs:\n'
    printf '  CCC_EMBED_BASE_URL: http://127.0.0.1:%s/v1\n  CCC_EMBED_API_KEY_FILE: %s\n' "$PORT" "$ROOT/token"
    for kv in "$@"; do printf '  %s\n' "$kv"; done; } > "$H/global_settings.yml"
  export CCCRUST_DIR="$H" CCCRUST_RUNTIME_DIR="$ROOT/$label/run"
  (cd "$P" && "$BIN" init >/dev/null 2>&1)
  LOGS="$LOGS $ROOT/$label/run/daemon.log"
}
index() { OUT=$(cd "$P" && "$BIN" index 2>&1); RC=$?; ALL_OUT="${ALL_OUT:-}$OUT"; }
nfiles() { (cd "$P" && "$BIN" status 2>&1 | grep -oE 'Files: +[0-9]+' | grep -oE '[0-9]+'); }
stop() { "$BIN" daemon stop >/dev/null 2>&1; }

# 1. 429 storm: every 3rd request.
start_mock FAULT_429_EVERY=3
setup storm 300 1; index; f=$(nfiles); n=$(stat n429)
check storm-all-indexed "$([ $RC -eq 0 ] && [ "$f" = 300 ] && [ "$n" -ge 50 ] && echo 1 || echo 0)" "rc=$RC files=$f 429s-served=$n"
# 5. Ledger after faults: reset + re-run pays nothing.
/usr/bin/curl -s -X POST "http://127.0.0.1:$PORT/reset" >/dev/null
(cd "$P" && "$BIN" reset -f >/dev/null 2>&1); index; f=$(nfiles); paid=$(stat inputs); stop
check ledger-consistent "$([ "$paid" = 0 ] && [ "$f" = 300 ] && echo 1 || echo 0)" "re-run after reset paid=$paid files=$f"
# Control: with retries off the same storm must break the run.
setup storm-noretry 300 1 'CCC_EMBED_RETRIES: "0"' 'CCC_EMBED_CACHE: "off"'; index; stop
check control-storm-bites-without-retry "$([ $RC -ne 0 ] || [ "$(nfiles)" != 300 ] && echo 1 || echo 0)" "rc=$RC (retries=0)"

# 2. Oversize: > 8 inputs rejected; ~30-chunk files must split.
start_mock FAULT_MAX_INPUTS=8
setup oversize 20 30; index; f=$(nfiles); n=$(stat n400); m=$(stat maxAccepted); stop
check oversize-split "$([ $RC -eq 0 ] && [ "$f" = 20 ] && [ "$n" -ge 1 ] && [ "$m" -le 8 ] && echo 1 || echo 0)" "rc=$RC files=$f rejections=$n largest-accepted=$m"

# 3. Slow: every 5th request stalls 10 s; client timeout 2 s.
start_mock FAULT_SLOW_EVERY=5 FAULT_SLOW_MS=10000
setup slow 100 1 'CCC_EMBED_TIMEOUT_S: "2"'
t0=$(date +%s); index; secs=$(( $(date +%s) - t0 )); f=$(nfiles); n=$(stat nslow); stop
check slow-timeouts-retried "$([ $RC -eq 0 ] && [ "$f" = 100 ] && [ "$n" -ge 1 ] && echo 1 || echo 0)" "rc=$RC files=$f stalls=$n wall=${secs}s"

# 4. Hard 401 fails fast.
start_mock FAULT_STATUS=401
setup hard401 50 1; index; reqs=$(stat requests); stop
# Match "failed (401)", not bare "401": the tmp dir is named hard401 and a
# bare grep matched the path (measured false positive on the first run).
check hard-4xx-fails-fast "$([ $RC -ne 0 ] && printf '%s' "$OUT" | grep -qF 'failed (401) after 1 attempt' && [ "$reqs" -le 2 ] && echo 1 || echo 0)" "rc=$RC requests=$reqs msg=$(printf '%s' "$OUT" | grep -m1 -oE 'failed \([0-9]+\) after [0-9]+ attempt')"

# 6. The bearer never appears in any log or output.
leaks=$(cat $LOGS 2>/dev/null | grep -c "$SECRET"); oleaks=$(printf '%s' "$ALL_OUT" | grep -c "$SECRET")
check no-key-leak "$([ "$leaks" = 0 ] && [ "$oleaks" = 0 ] && echo 1 || echo 0)" "log hits=$leaks output hits=$oleaks across $(echo $LOGS | wc -w | tr -d ' ') daemon logs"
# Positive control for the leak grep: the logs are readable and contain a
# known string (the daemon's own banner), so zero secret hits means something.
banner=$(cat $LOGS 2>/dev/null | grep -c 'Daemon listening')
check leak-instrument-reads-logs "$([ "$banner" -ge 5 ] && echo 1 || echo 0)" "banner lines found=$banner"
exit $fail
