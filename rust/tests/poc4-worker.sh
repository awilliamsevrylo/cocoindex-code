#!/usr/bin/env bash
# POC 4 live witness: Rust ccc indexes + searches through the voyage-egress
# Worker (provider: litellm). Isolated COCOINDEX_CODE_DIR; the bearer is read
# from a file path, never echoed.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
BIN="${CCC_BIN:-$REPO/rust/target/debug/ccc}"
FIX="$REPO/tests/e2e_docker_fixtures/sample_project"
BASE="${BASE:-https://voyage-egress.andrwill1995.workers.dev/v1}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.drew/voyage-egress.token}"
MODEL="${MODEL:-voyage/voyage-4-large}"
ROOT="${TMPDIR:-/tmp}/ccc_poc4"
fail=0
check() { if [ "$2" = "1" ]; then echo "PASS $1: $3"; else echo "FAIL $1: $3"; fail=1; fi; }

setup_home() { # $1 = token file to use
  rm -rf "$ROOT"; mkdir -p "$ROOT/home" "$ROOT/proj"; cp -r "$FIX"/* "$ROOT/proj/"
  export COCOINDEX_CODE_DIR="$ROOT/home" COCOINDEX_CODE_RUNTIME_DIR="$ROOT/run"
  cat > "$ROOT/home/global_settings.yml" <<EOF
embedding:
  provider: litellm
  model: $MODEL
  indexing_params:
    input_type: document
  query_params:
    input_type: query
envs:
  CCC_EMBED_BASE_URL: $BASE
  CCC_EMBED_API_KEY_FILE: $1
EOF
  cd "$ROOT/proj" && $BIN init >/dev/null 2>&1
}

# 4. Fail loud on a wrong bearer (runs first, own home, then torn down).
printf 'wrong-token-%s\n' "$RANDOM$RANDOM$RANDOM$RANDOM" > "$ROOT.badtok"
setup_home "$ROOT.badtok"
out=$($BIN index 2>&1); rc=$?
$BIN daemon stop >/dev/null 2>&1
check bad-bearer-fails-loud "$(printf '%s' "$out" | grep -q '401' && echo 1 || echo 0)" "rc=$rc, lines mentioning 401: $(printf '%s' "$out" | grep -c 401)"
check bad-bearer-no-token-echo "$(printf '%s' "$out" | grep -qF "$(cat "$ROOT.badtok")" && echo 0 || echo 1)" "wrong token not echoed"
rm -f "$ROOT.badtok"

# 2. Index through the Worker.
setup_home "$TOKEN_FILE"
out=$($BIN index 2>&1); rc=$?
echo "$out" | tail -5
check index-exit-0 "$([ $rc -eq 0 ] && echo 1 || echo 0)" "rc=$rc"
chunks=$($BIN status 2>&1 | grep -oE 'Chunks: [0-9]+' | grep -oE '[0-9]+')
check chunks-positive "$([ "${chunks:-0}" -gt 0 ] && echo 1 || echo 0)" "chunks=${chunks:-none}"
DB="$ROOT/proj/.cocoindex_code/target_sqlite.db"
ddl=$(/usr/bin/sqlite3 "$DB" "SELECT sql FROM sqlite_master WHERE name='code_chunks_vec'" 2>&1)
check vec-dims-1024 "$(printf '%s' "$ddl" | grep -q 'float\[1024\]' && echo 1 || echo 0)" "ddl=$(printf '%s' "$ddl" | grep -oE 'float\[[0-9]+\]')"

# 3. Search through the Worker (query-side params).
out=$($BIN search "verify password" --limit 1 2>&1)
check search-top-hit "$(printf '%s' "$out" | grep -m1 'File:' | grep -q 'src/auth.py' && echo 1 || echo 0)" "$(printf '%s' "$out" | grep -m1 'File:')"
out=$($BIN search "request handler dispatch" --limit 1 2>&1)
check search-second-query "$(printf '%s' "$out" | grep -m1 'File:' | grep -q 'handlers.py' && echo 1 || echo 0)" "$(printf '%s' "$out" | grep -m1 'File:')"

$BIN daemon stop >/dev/null 2>&1
exit $fail
