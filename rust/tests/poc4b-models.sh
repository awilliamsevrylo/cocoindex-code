#!/usr/bin/env bash
# POC 4b live witness: two projects, two embedding models, ONE daemon.
# A = global local fastembed (bge-small, 384). B = per-index override
# voyage/voyage-4-large through the voyage-egress Worker (1024). Then B is
# re-pinned to another model and search must refuse, not mix vector spaces.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
BIN="${CCC_BIN:-$REPO/rust/target/debug/cccrust}"
FIX="$REPO/tests/e2e_docker_fixtures/sample_project"
BASE="${BASE:-https://voyage-egress.andrwill1995.workers.dev/v1}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.drew/voyage-egress.token}"
ROOT="${TMPDIR:-/tmp}/ccc_poc4b"
fail=0
check() { if [ "$2" = "1" ]; then echo "PASS $1: $3"; else echo "FAIL $1: $3"; fail=1; fi; }
ddl() { /usr/bin/sqlite3 "$1/.cccrust/target_sqlite.db" "SELECT sql FROM sqlite_master WHERE name='code_chunks_vec'" | grep -oE 'float\[[0-9]+\]'; }
meta() { /usr/bin/sqlite3 "$1/.cccrust/target_sqlite.db" "SELECT v FROM ccc_index_meta WHERE k='model'" 2>&1; }

rm -rf "$ROOT"; mkdir -p "$ROOT/home" "$ROOT/A" "$ROOT/B"
cp -r "$FIX"/* "$ROOT/A/"; cp -r "$FIX"/* "$ROOT/B/"
export CCCRUST_DIR="$ROOT/home" CCCRUST_RUNTIME_DIR="$ROOT/run"
cat > "$ROOT/home/global_settings.yml" <<EOF
embedding:
  provider: sentence-transformers
  model: BAAI/bge-small-en-v1.5
envs:
  CCC_EMBED_BASE_URL: $BASE
  CCC_EMBED_API_KEY_FILE: $TOKEN_FILE
EOF

(cd "$ROOT/A" && $BIN init >/dev/null 2>&1)
out=$(cd "$ROOT/B" && $BIN init --index-model voyage/voyage-4-large 2>&1)
check init-pins-model "$(grep -q 'model: voyage/voyage-4-large' "$ROOT/B/.cccrust/settings.yml" && grep -q 'provider: litellm' "$ROOT/B/.cccrust/settings.yml" && echo 1 || echo 0)" "B settings.yml carries the override"

(cd "$ROOT/A" && $BIN index >/dev/null 2>&1); ra=$?
(cd "$ROOT/B" && $BIN index >/dev/null 2>&1); rb=$?
pid1=$(cat "$ROOT/run/daemon.pid" 2>/dev/null)
check both-index "$([ $ra -eq 0 ] && [ $rb -eq 0 ] && echo 1 || echo 0)" "A rc=$ra B rc=$rb"
check A-dims-384 "$([ "$(ddl "$ROOT/A")" = "float[384]" ] && echo 1 || echo 0)" "A $(ddl "$ROOT/A"), meta=$(meta "$ROOT/A")"
check B-dims-1024 "$([ "$(ddl "$ROOT/B")" = "float[1024]" ] && echo 1 || echo 0)" "B $(ddl "$ROOT/B"), meta=$(meta "$ROOT/B")"
check meta-per-db "$([ "$(meta "$ROOT/A")" = "sentence-transformers:BAAI/bge-small-en-v1.5" ] && [ "$(meta "$ROOT/B")" = "litellm:voyage/voyage-4-large" ] && echo 1 || echo 0)" "each db names its own model"

# bge-small ranks handlers.py (which imports verify_password) first and
# auth.py second — measured identical on the pre-POC-4b binary — so A is
# checked top-2, the same bar e2e_cli.sh uses for the local model.
oa=$(cd "$ROOT/A" && $BIN search "verify password" --limit 2 2>&1 | grep 'File:' | tr '\n' ' ')
ob=$(cd "$ROOT/B" && $BIN search "verify password" --limit 1 2>&1 | grep -m1 'File:')
pid2=$(cat "$ROOT/run/daemon.pid" 2>/dev/null)
check A-search-top2 "$(printf '%s' "$oa" | grep -q auth.py && echo 1 || echo 0)" "$oa"
check B-search "$(printf '%s' "$ob" | grep -q auth.py && echo 1 || echo 0)" "$ob"
check one-daemon "$([ -n "$pid1" ] && [ "$pid1" = "$pid2" ] && echo 1 || echo 0)" "pid $pid1 served both"
st=$(cd "$ROOT/B" && $BIN status 2>&1 | grep 'Index model')
check status-shows-model "$(printf '%s' "$st" | grep -q 'voyage-4-large (1024 dims)' && echo 1 || echo 0)" "$st"

# Re-pin B to another model; do NOT reindex. Search must refuse.
(cd "$ROOT/B" && $BIN init --index-model voyage/voyage-code-4 >/dev/null 2>&1)
out=$(cd "$ROOT/B" && $BIN search "verify password" --limit 1 2>&1)
check mismatch-refused "$(printf '%s' "$out" | grep -q 'voyage-4-large' && printf '%s' "$out" | grep -q 'voyage-code-4' && ! printf '%s' "$out" | grep -q 'File:' && echo 1 || echo 0)" "$(printf '%s' "$out" | grep -m1 -iE 'built with|error' | cut -c1-160)"
# A is untouched by B's change.
oa2=$(cd "$ROOT/A" && $BIN search "verify password" --limit 2 2>&1 | grep 'File:' | tr '\n' ' ')
check A-unaffected-top2 "$(printf '%s' "$oa2" | grep -q auth.py && echo 1 || echo 0)" "$oa2"

$BIN daemon stop >/dev/null 2>&1
exit $fail
