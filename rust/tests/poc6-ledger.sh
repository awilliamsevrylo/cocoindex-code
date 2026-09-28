#!/usr/bin/env bash
# POC 6 witness: a re-run / crash-resume never pays twice. The local mock
# counts every input it is sent (= Voyage spend). Zero real spend.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="${CCC_BIN:-$HERE/../target/debug/cccrust}"
NODE="${NODE:-$(command -v node)}"
ROOT="${TMPDIR:-/tmp}/ccc_poc6"
fail=0
check() { if [ "$2" = "1" ]; then echo "PASS $1: $3"; else echo "FAIL $1: $3"; fail=1; fi; }

rm -rf "$ROOT"; mkdir -p "$ROOT"
start_mock() { # $1 = hold ms
  "$NODE" "$HERE/mock-embeddings.mjs" "$ROOT/port" 16 "$1" & MOCK=$!
  for _ in $(seq 1 50); do [ -s "$ROOT/port" ] && break; sleep 0.1; done
  PORT=$(cat "$ROOT/port")
}
trap 'kill $MOCK 2>/dev/null; "$BIN" daemon stop >/dev/null 2>&1' EXIT
spent() { /usr/bin/curl -s "http://127.0.0.1:$PORT/stats" | jq .inputs; }
zero() { /usr/bin/curl -s -X POST "http://127.0.0.1:$PORT/reset" >/dev/null; }

setup() { # $1 label, $2 files, $3 cache on|off, $4 cap, $5 identical?
  H="$ROOT/$1/home"; P="$ROOT/$1/proj"; mkdir -p "$H" "$P/src"
  for i in $(seq 1 "$2"); do
    if [ "${5:-}" = same ]; then printf 'def same():\n    return "identical body"\n' > "$P/src/f$i.py"
    else printf 'def fn_%s(x):\n    """Doc %s."""\n    return x + %s\n' "$i" "$i" "$i" > "$P/src/f$i.py"; fi
  done
  cache_line=""; [ "$3" = off ] && cache_line='  CCC_EMBED_CACHE: "off"'
  cat > "$H/global_settings.yml" <<EOF
embedding:
  provider: litellm
  model: mock-embed
envs:
  CCC_EMBED_BASE_URL: http://127.0.0.1:$PORT/v1
  CCC_EMBED_MAX_INFLIGHT: "$4"
$cache_line
EOF
  export CCCRUST_DIR="$H" CCCRUST_RUNTIME_DIR="$ROOT/$1/run"
  (cd "$P" && "$BIN" init >/dev/null 2>&1)
}
index() { (cd "$P" && "$BIN" index >/dev/null 2>&1); }
nfiles() { (cd "$P" && "$BIN" status 2>&1 | grep -oE 'Files: +[0-9]+' | grep -oE '[0-9]+'); }
reset_proj() { (cd "$P" && "$BIN" reset -f >/dev/null 2>&1); }

start_mock 5

# 1. Re-run after reset pays zero.
setup rerun 200 on 8; zero; index; first=$(spent)
reset_proj; zero; index; second=$(spent); f=$(nfiles); "$BIN" daemon stop >/dev/null 2>&1
check first-run-pays "$([ "$first" -ge 200 ] && [ "$first" -le 201 ] && echo 1 || echo 0)" "first=$first (200 chunks + probe)"
check rerun-pays-zero "$([ "$second" = 0 ] && [ "$f" = 200 ] && echo 1 || echo 0)" "after reset: spent=$second, files=$f"

# 2. Control: cache off, the same re-run pays again.
setup control 200 off 8; zero; index; reset_proj; zero; index; csecond=$(spent); "$BIN" daemon stop >/dev/null 2>&1
check control-cache-off-pays "$([ "$csecond" -ge 200 ] && echo 1 || echo 0)" "cache off re-run spent=$csecond"

# 4. Identical content across files.
setup dedupe 100 on 8 same; zero; index; d=$(spent); f=$(nfiles); "$BIN" daemon stop >/dev/null 2>&1
check dedupe-across-files "$([ "$d" -le 2 ] && [ "$f" = 100 ] && echo 1 || echo 0)" "100 identical files spent=$d, files=$f"

# 3. Crash mid-run (kill -9 the daemon), then resume.
kill $MOCK; wait $MOCK 2>/dev/null; rm -f "$ROOT/port"; start_mock 60
CAP=2; setup crash 400 on $CAP; zero
(cd "$P" && "$BIN" index >/dev/null 2>&1) & IDX=$!
for _ in $(seq 1 100); do s=$(spent); [ "${s:-0}" -ge 100 ] && break; sleep 0.1; done
before_kill=$(spent)
kill -9 "$(cat "$ROOT/crash/run/daemon.pid")" 2>/dev/null; wait $IDX 2>/dev/null
sleep 1; at_kill=$(spent)
index; total=$(spent); f=$(nfiles); "$BIN" daemon stop >/dev/null 2>&1
check crash-was-mid-run "$([ "$at_kill" -gt 0 ] && [ "$at_kill" -lt 400 ] && echo 1 || echo 0)" "killed after spend=$at_kill of 400"
check crash-resume-no-double-pay "$([ "$total" -le $((400 + 1 + CAP)) ] && [ "$f" = 400 ] && echo 1 || echo 0)" "total spend=$total (limit $((400 + 1 + CAP))), files=$f"
exit $fail
