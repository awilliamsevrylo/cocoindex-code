#!/usr/bin/env bash
# Regenerate the Android docs corpus end to end, then index and spot-check it.
# Every stage is resumable, so rerunning after a failure (or with --from) only
# pays for unfinished work:
#   urls     node corpus/jobs/android-docs-urls.mjs          (sitemap -> URL list)
#   android  node fanout/cli.mjs run corpus/jobs/android-docs.json
#   aosp     node fanout/cli.mjs run corpus/jobs/aosp-docs.json
#   watch    node fanout/cli.mjs watch <both jobs> --until-done
#   assemble bash corpus/assemble.sh                         (Wasabi -> local tree)
#   index    bash rust/tests/poc9-corpus.sh                  (cccrust index + queries)
#
# Usage: bash corpus/regen.sh [--from STAGE] [--to STAGE] [--dry-run] [-- assemble args]
#   --dry-run  print stage commands; assemble runs with --dry-run (listing only),
#              index is skipped
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STAGES=(urls android aosp watch assemble index)
FROM=urls; TO=index; DRY=0; EXTRA=()
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
cmd_for() {
  case "$1" in
    urls) echo "node corpus/jobs/android-docs-urls.mjs" ;;
    android) echo "node fanout/cli.mjs run ${JOBS[0]}" ;;
    aosp) echo "node fanout/cli.mjs run ${JOBS[1]}" ;;
    watch) echo "node fanout/cli.mjs watch ${JOBS[*]} --until-done" ;;
    assemble) echo "bash corpus/assemble.sh$( [ "$DRY" = 1 ] && echo ' --dry-run')${EXTRA[*]:+ ${EXTRA[*]}}" ;;
    index) echo "bash rust/tests/poc9-corpus.sh" ;;
  esac
}

for ((i = F; i <= T; i++)); do
  s=${STAGES[$i]}; c=$(cmd_for "$s")
  echo "== [$((i + 1))/${#STAGES[@]}] $s: $c"
  if [ "$DRY" = 1 ] && [ "$s" != assemble ]; then echo "   (dry-run: not executed)"; continue; fi
  t0=$(date +%s)
  bash -c "$c"; rc=$?
  echo "== $s rc=$rc in $(( $(date +%s) - t0 ))s"
  if [ "$rc" != 0 ]; then
    echo "stopped at '$s'. Fix and resume with: bash corpus/regen.sh --from $s" >&2
    exit "$rc"
  fi
done
echo "regen done (${STAGES[$F]} .. ${STAGES[$T]})"
