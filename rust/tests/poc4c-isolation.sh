#!/usr/bin/env bash
# POC 4c witness: cccrust never reads ~/.cocoindex_code or COCOINDEX_CODE_*.
# HOME is sandboxed so the real ~/.cocoindex_code is never touched. No
# CCCRUST_* overrides are set: the default ~/.cccrust path is what is tested.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
BIN="${CCC_BIN:-$REPO/rust/target/debug/cccrust}"
FIX="$REPO/tests/e2e_docker_fixtures/sample_project"
ROOT="${TMPDIR:-/tmp}/ccc_poc4c"
fail=0
check() { if [ "$2" = "1" ]; then echo "PASS $1: $3"; else echo "FAIL $1: $3"; fail=1; fi; }
POISON='embedding:
  provider: poisoned-provider-zz
  model: nope
'
fresh() {
  rm -rf "$ROOT"; mkdir -p "$ROOT/home/.cocoindex_code" "$ROOT/proj"; cp -r "$FIX"/* "$ROOT/proj/"
  unset CCCRUST_DIR CCCRUST_RUNTIME_DIR
  export HOME="$ROOT/home"
}

[ -x "$BIN" ] || { echo "FAIL build: $BIN missing"; exit 1; }
check binary-named-cccrust "$([ "$(basename "$BIN")" = cccrust ] && echo 1 || echo 0)" "$(basename "$BIN")"

# 1. Poison the Python tool's config; cccrust must not notice.
fresh
printf '%s' "$POISON" > "$HOME/.cocoindex_code/global_settings.yml"
export COCOINDEX_CODE_DIR="$HOME/.cocoindex_code" COCOINDEX_CODE_RUNTIME_DIR="$HOME/.cocoindex_code"
cd "$ROOT/proj"
$BIN init >/dev/null 2>&1; ri=$?
$BIN index >/dev/null 2>&1; rx=$?
out=$($BIN search "verify password" --limit 2 2>&1)
$BIN daemon stop >/dev/null 2>&1
check ignores-python-config "$([ $ri -eq 0 ] && [ $rx -eq 0 ] && printf '%s' "$out" | grep -q 'auth.py' && echo 1 || echo 0)" "init=$ri index=$rx search hit=$(printf '%s' "$out" | grep -c auth.py)"
check writes-own-global "$([ -f "$HOME/.cccrust/global_settings.yml" ] && [ -S "$HOME/.cccrust/daemon.sock" -o -f "$HOME/.cccrust/daemon.log" ] && echo 1 || echo 0)" "$(ls "$HOME/.cccrust" | tr '\n' ' ')"
check writes-own-project-dir "$([ -f "$ROOT/proj/.cccrust/target_sqlite.db" ] && [ ! -e "$ROOT/proj/.cocoindex_code" ] && echo 1 || echo 0)" "proj/.cccrust has db, no proj/.cocoindex_code"
check python-dir-untouched "$([ "$(ls -A "$HOME/.cocoindex_code")" = "global_settings.yml" ] && echo 1 || echo 0)" "$(ls -A "$HOME/.cocoindex_code" | tr '\n' ' ')"
unset COCOINDEX_CODE_DIR COCOINDEX_CODE_RUNTIME_DIR

# 2. Positive control: the same poison in cccrust's own dir must bite.
fresh
mkdir -p "$HOME/.cccrust"; printf '%s' "$POISON" > "$HOME/.cccrust/global_settings.yml"
cd "$ROOT/proj"
$BIN init >/dev/null 2>&1
out=$($BIN index 2>&1); rc=$?
$BIN daemon stop >/dev/null 2>&1
check control-poison-bites "$({ [ $rc -ne 0 ] || printf '%s' "$out" | grep -qi 'error'; } && printf '%s' "$out" | grep -q 'poisoned-provider-zz' && echo 1 || echo 0)" "rc=$rc: $(printf '%s' "$out" | grep -m1 'poisoned-provider-zz' | cut -c1-120)"

# 3. Source has no reference to the Python tool's config.
hits=$(/usr/bin/grep -rn 'COCOINDEX_CODE\|\.cocoindex_code' "$REPO/rust/src" | wc -l | tr -d ' ')
check src-no-python-config "$([ "$hits" = 0 ] && echo 1 || echo 0)" "hits=$hits"
exit $fail
