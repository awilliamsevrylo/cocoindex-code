#!/usr/bin/env bash
# AOSP git-docs sweep worker. For each repo: blobless depth-1 clone, pick the
# prose docs from the tree listing, sparse-checkout only those, copy them to
# $OUT_DIR/<repo>/. Idempotent and resumable: items already marked `ok` in
# MANIFEST.tsv are skipped; FAIL items are retried.
#
# Fanout worker contract (fanout/README.md), env:
#   ITEMS_FILE  one item per line: <repo> or <repo>@<branch> (no tabs), or a
#               repos.tsv line (name<TAB>sizeMB<TAB>branch...) for standalone use
#   OUT_DIR     output root (MANIFEST.tsv + <repo>/...)
#   LANE, LANE_INDEX   informational (logged)
# Standalone: ITEMS_FILE=items.txt OUT_DIR=/tmp/aosp-docs bash sweep.sh
#
# MANIFEST.tsv: item<TAB>ok|FAIL<TAB>status<TAB>branch<TAB>doc_files<TAB>doc_bytes
# (column 2 is what fanout resumes on; the item is column 1 verbatim).
#   ok:   OK · NO_DOCS · SKIP_META (.github etc) · SKIP_DEAD (no refs, twice)
#   FAIL: CLONE_FAIL (reachable, clone failed after retries) · COPY_FAIL
#         (docs listed, 0 harvested) — both retried on the next run.
set -uo pipefail
export GIT_TERMINAL_PROMPT=0
: "${ITEMS_FILE:?ITEMS_FILE required}" "${OUT_DIR:?OUT_DIR required}"
BASE_URL="${AOSP_BASE_URL:-https://github.com/aosp-mirror}"
WORK="${WORK_DIR:-${TMPDIR:-/tmp}/aosp-sweep-work}"
MANIFEST="$OUT_DIR/MANIFEST.tsv"
RETRIES="${CLONE_RETRIES:-3}"

# Root cause of the 17 CLONE_FAILs in the first sweep (2026-09-28): the lanes
# ran the loop before git existed in a fresh container, so every clone failed
# instantly; all 17 cloned fine on re-probe. Refuse to start without git.
command -v git >/dev/null || { echo "sweep: git not installed" >&2; exit 3; }
command -v tar >/dev/null || { echo "sweep: tar not installed" >&2; exit 3; }
mkdir -p "$WORK" "$OUT_DIR"
# Absolute: the harvest subshell cds into the clone before writing here.
OUT_DIR=$(cd "$OUT_DIR" && pwd); MANIFEST="$OUT_DIR/MANIFEST.tsv"
touch "$MANIFEST"   # no header: fanout reads column 2 of every line

is_doc() {
  case "$1" in
    *testdata/*|*/tests/*|/test/*|*/api/*|*third_party/*|*node_modules/*|*.github/*) return 1 ;;
  esac
  case "$1" in
    Documentation/*|*/Documentation/*|docs/*|*/docs/*|doc/*|*/doc/*) return 0 ;;
    *.rst|*.md) return 0 ;;
    README|README.*|*/README|*/README.*|CONTRIBUTING*|HACKING*|INSTALL*) return 0 ;;
  esac
  return 1
}
is_asset() {
  case "$1" in
    */downloads/*|*/brand/*|*.ai|*.png|*.jpg|*.jpeg|*.gif|*.svg|*.html|*.woff*|*.ttf|*.ico|*.pdf) return 0 ;;
  esac
  return 1
}
done_status() { awk -F'\t' -v r="$1" '$1==r && $2=="ok" {f=1} END{exit !f}' "$MANIFEST"; }
record() { # item status branch files bytes
  local okf=ok; case "$2" in *FAIL) okf=FAIL ;; esac
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$okf" "$2" "$3" "$4" "$5" >> "$MANIFEST"
}

# Resolve which ref to clone: the listed branch if the remote has it, else the
# remote HEAD. Prints the branch, or nothing when the repo is unreachable.
resolve_branch() {
  local url=$1 want=$2 lr
  lr=$(git ls-remote --symref "$url" HEAD "refs/heads/$want" 2>/dev/null) || return 1
  if printf '%s\n' "$lr" | grep -q "refs/heads/$want\$"; then echo "$want"; return 0; fi
  printf '%s\n' "$lr" | awk '/^ref:/{sub("refs/heads/","",$2); print $2; exit}'
}

clone() { # url branch dir -> 0 on success, with retries + backoff
  local i
  for i in $(seq 1 "$RETRIES"); do
    rm -rf "$3"
    git clone -q --filter=blob:none --depth 1 --no-checkout --branch "$2" "$1" "$3" 2>"$WORK/clone-err.txt" && return 0
    sleep $((i * 5))
  done
  return 1
}

ok=0; fail=0; skip=0; n=0
count=$(grep -c . "$ITEMS_FILE")
echo "sweep lane=${LANE:-local}#${LANE_INDEX:-0}: $count repos -> $OUT_DIR"
while IFS= read -r line; do
  [ -z "${line:-}" ] && continue
  case "$line" in
    *$'\t'*) item=${line%%$'\t'*}; branch=$(printf '%s' "$line" | cut -f3) ;;  # repos.tsv line
    *@*)     item=$line; branch=${line#*@} ;;
    *)       item=$line; branch=main ;;
  esac
  repo=${item%%@*}; branch=${branch:-main}
  n=$((n + 1))
  if done_status "$item"; then skip=$((skip + 1)); continue; fi
  case "$repo" in .*|*.github.io) record "$item" SKIP_META "$branch" 0 0; continue ;; esac
  url="$BASE_URL/$repo.git"
  echo "[$n/$count] $repo ($branch)"
  ref=$(resolve_branch "$url" "$branch")
  if [ -z "$ref" ]; then
    # Unreachable or no refs at all: confirm twice before calling it dead.
    sleep 3; ref=$(resolve_branch "$url" "$branch")
    if [ -z "$ref" ]; then record "$item" SKIP_DEAD "$branch" 0 0; echo "    dead (no refs)"; continue; fi
  fi
  dir="$WORK/$repo"
  if ! clone "$url" "$ref" "$dir"; then
    record "$item" CLONE_FAIL "$ref" 0 0
    echo "    !! CLONE_FAIL: $(tail -1 "$WORK/clone-err.txt" | cut -c1-160)"
    fail=$((fail + 1)); continue
  fi
  # Names only: `ls-tree -l` on a blobless clone lazily fetches EVERY blob to
  # report its size (webkit stalled for minutes). Bytes are measured after the
  # sparse checkout, which fetches only the doc blobs.
  ( cd "$dir" && git ls-tree -r --name-only HEAD ) > "$WORK/lstree.txt"
  : > "$WORK/docpaths.txt"; files=0
  while IFS= read -r path; do
    [ -z "${path:-}" ] && continue
    is_doc "$path" || continue
    is_asset "$path" && continue
    printf '%s\n' "$path" >> "$WORK/docpaths.txt"
    files=$((files + 1))
  done < "$WORK/lstree.txt"
  if [ "$files" -eq 0 ]; then
    record "$item" NO_DOCS "$ref" 0 0; rm -rf "$dir"; ok=$((ok + 1)); continue
  fi
  rm -rf "${OUT_DIR:?}/$repo"; mkdir -p "$OUT_DIR/$repo"
  ( cd "$dir" && git sparse-checkout init --no-cone >/dev/null 2>&1
    git sparse-checkout set --no-cone --stdin < "$WORK/docpaths.txt" >/dev/null 2>&1
    git checkout -q 2>/dev/null
    # busybox cp lacks --parents (silent empty harvest); tar preserves paths
    tar -cf - -T "$WORK/docpaths.txt" 2>/dev/null | (cd "$OUT_DIR/$repo" && tar -xf -) )
  got=$(find "$OUT_DIR/$repo" -type f | wc -l | tr -d ' ')
  bytes=$(find "$OUT_DIR/$repo" -type f -exec cat {} + 2>/dev/null | wc -c | tr -d ' ')
  rm -rf "$dir"
  if [ "$got" -eq 0 ]; then
    record "$item" COPY_FAIL "$ref" "$files" 0; echo "    !! COPY_FAIL expected=$files"
    fail=$((fail + 1)); continue
  fi
  record "$item" OK "$ref" "$got" "$bytes"
  echo "    -> doc_files=$got bytes=$bytes"
  ok=$((ok + 1))
done < "$ITEMS_FILE"

echo "SUMMARY ok=$ok fail=$fail skipped_done=$skip total=$count"
[ "$fail" -eq 0 ]
