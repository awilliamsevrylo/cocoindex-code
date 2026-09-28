#!/usr/bin/env bash
# POC 5 witness: cccrust over 1,000 files never exceeds CCC_EMBED_MAX_INFLIGHT
# concurrent embed requests. Local mock server; zero Voyage spend.
# Control: the same run with a huge cap must show peak > CAP, else the
# instrument cannot see concurrency and the capped result proves nothing.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="${CCC_BIN:-$HERE/../target/debug/cccrust}"
NODE="${NODE:-$(command -v node)}"
ROOT="${TMPDIR:-/tmp}/ccc_poc5"
FILES="${FILES:-1000}"
CAP="${CAP:-8}"
fail=0
check() { if [ "$2" = "1" ]; then echo "PASS $1: $3"; else echo "FAIL $1: $3"; fail=1; fi; }

rm -rf "$ROOT"; mkdir -p "$ROOT"
"$NODE" "$HERE/mock-embeddings.mjs" "$ROOT/port" 16 30 & MOCK=$!
trap 'kill $MOCK 2>/dev/null; "$BIN" daemon stop >/dev/null 2>&1' EXIT
for i in $(seq 1 50); do [ -s "$ROOT/port" ] && break; sleep 0.1; done
PORT=$(cat "$ROOT/port")
stats() { /usr/bin/curl -s "http://127.0.0.1:$PORT/stats"; }

run() { # $1 = cap, $2 = label
  local home="$ROOT/$2/home" proj="$ROOT/$2/proj"
  mkdir -p "$home" "$proj/src"
  for i in $(seq 1 "$FILES"); do
    printf 'def handler_%s(x):\n    """Unique doc %s for file %s."""\n    return x * %s\n' "$i" "$i" "$i" "$i" > "$proj/src/f$i.py"
  done
  cat > "$home/global_settings.yml" <<EOF
embedding:
  provider: litellm
  model: mock-embed
envs:
  CCC_EMBED_BASE_URL: http://127.0.0.1:$PORT/v1
  CCC_EMBED_MAX_INFLIGHT: "$1"
EOF
  export CCCRUST_DIR="$home" CCCRUST_RUNTIME_DIR="$ROOT/$2/run"
  /usr/bin/curl -s -X POST "http://127.0.0.1:$PORT/reset" >/dev/null
  (cd "$proj" && "$BIN" init >/dev/null 2>&1)
  local t0=$(date +%s)
  (cd "$proj" && "$BIN" index >/dev/null 2>&1); RC=$?
  SECS=$(( $(date +%s) - t0 ))
  CHUNKS=$(cd "$proj" && "$BIN" status 2>&1 | grep -oE 'Chunks: [0-9]+' | grep -oE '[0-9]+')
  FILESIX=$(cd "$proj" && "$BIN" status 2>&1 | grep -oE 'Files: +[0-9]+' | grep -oE '[0-9]+')
  STATS=$(stats)
  "$BIN" daemon stop >/dev/null 2>&1
}

run "$CAP" capped
peak=$(printf '%s' "$STATS" | jq .peak)
echo "capped: rc=$RC ${SECS}s files=$FILESIX chunks=$CHUNKS mock=$STATS"
check capped-index-ok "$([ $RC -eq 0 ] && echo 1 || echo 0)" "rc=$RC"
check all-files-indexed "$([ "${FILESIX:-0}" -eq "$FILES" ] && echo 1 || echo 0)" "files=$FILESIX of $FILES"
check peak-within-cap "$([ "$peak" -le "$CAP" ] && [ "$peak" -ge 1 ] && echo 1 || echo 0)" "peak=$peak cap=$CAP"

run 100000 control
cpeak=$(printf '%s' "$STATS" | jq .peak)
echo "control: rc=$RC ${SECS}s files=$FILESIX mock=$STATS"
check control-sees-concurrency "$([ "$cpeak" -gt "$CAP" ] && echo 1 || echo 0)" "uncapped peak=$cpeak > $CAP"
exit $fail
