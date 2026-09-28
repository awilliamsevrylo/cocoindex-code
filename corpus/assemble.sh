#!/usr/bin/env bash
# Assemble the crawled corpus from Wasabi into one local tree, merging lanes.
#
#   wasabimb:<bucket>/android-docs-pw/<lane>/**  ->  $DEST/android-docs/**
#   wasabimb:<bucket>/aosp-docs-v2/<lane>/**     ->  $DEST/aosp-docs/**
#
# Incremental and safe to rerun: `rclone copy --update` (never `sync`), so
# nothing local is deleted and unchanged files are not re-transferred.
# Lane MANIFEST.tsv files are not copied into the tree; they are merged into
# $DEST/MANIFEST.tsv (lane + source columns prepended) instead.
#
# The merged manifest is written to a temp file and moved into place ONLY when
# every lane listing, copy and manifest read succeeded, at least one lane was
# found, and the row count did not shrink (unless --allow-shrink). Any failure
# leaves the previous MANIFEST.tsv untouched and exits non-zero.
#
# Usage: bash corpus/assemble.sh [--dry-run] [--source new|legacy] [--prune-legacy] [--allow-shrink]
#   --dry-run       list what would be copied (rclone --dry-run); writes nothing,
#                   creates no directories
#   --source legacy read the old aosp-shard-NN/{android-docs,aosp-docs} layout
#                   (the Jina-era crawl) into the same new local layout
#   --prune-legacy  after a successful copy, delete the LOCAL legacy
#                   $DEST/aosp-shard-* dirs (off by default; never touches Wasabi)
#   --allow-shrink  accept a merged manifest with fewer rows than the previous one
# Env: CORPUS_DEST (default ~/PROJECTS/aosp-docs), RCLONE_CONF, CORPUS_BUCKET
set -uo pipefail

CONF="${RCLONE_CONF:-$HOME/.drew/rclone-wasabimb.conf}"
BUCKET="${CORPUS_BUCKET:-wasabimb:drew-aosp-docs-20260928}"
DEST="${CORPUS_DEST:-$HOME/PROJECTS/aosp-docs}"
DRY=0; SOURCE=new; PRUNE=0; SHRINK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --source) SOURCE="$2"; shift ;;
    --prune-legacy) PRUNE=1 ;;
    --allow-shrink) SHRINK=1 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -r "$CONF" ] || { echo "rclone config not readable: $CONF" >&2; exit 2; }
rc() { rclone --config "$CONF" "$@"; }

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/assemble.XXXXXX")"
trap 'rm -rf "$TMPD"' EXIT
MAN_TMP="$TMPD/rows"; : > "$MAN_TMP"
failed=0
fail() { failed=1; echo "  FAILED: $*" >&2; }

# kind -> "local_name<TAB>remote_path" lines in $TMPD/lanes; non-zero if the
# listing itself failed (a failed listing is NOT an empty bucket).
lanes() {
  local kind=$1 top out
  if [ "$SOURCE" = legacy ]; then
    out=$(rc lsf --dirs-only "$BUCKET") || return 1
    printf '%s\n' "$out" | grep -E '^aosp-shard-[0-9]+/$' | tr -d / | while read -r l; do
      printf '%s\t%s\n' "$l" "$BUCKET/$l/$kind"
    done
  else
    [ "$kind" = android-docs ] && top=android-docs-pw || top=aosp-docs-v2
    out=$(rc lsf --dirs-only "$BUCKET/$top") || return 1
    printf '%s\n' "$out" | tr -d / | while read -r l; do
      [ -n "$l" ] && printf '%s\t%s\n' "$l" "$BUCKET/$top/$l"
    done
  fi
  return 0
}

FLAGS=(--update --transfers 32 --checkers 32 --fast-list --exclude 'MANIFEST.tsv' --exclude '.DS_Store')
[ "$DRY" = 1 ] && FLAGS+=(--dry-run)
[ "$DRY" = 1 ] || mkdir -p "$DEST"

total=0; nlanes=0
printf '%-14s %-14s %8s %8s\n' kind lane remote would_copy
for kind in android-docs aosp-docs; do
  kind_n=0
  if ! lanes "$kind" > "$TMPD/lanes"; then fail "lane listing for $kind"; continue; fi
  while IFS=$'\t' read -r lane remote; do
    [ -z "$lane" ] && continue
    nlanes=$((nlanes + 1))
    if ! listing=$(rc lsf -R --files-only --exclude MANIFEST.tsv "$remote"); then
      fail "file listing $kind/$lane"; continue
    fi
    nremote=$(printf '%s' "$listing" | grep -c .)
    log=$(rc copy "$remote" "$DEST/$kind" "${FLAGS[@]}" -v 2>&1); code=$?
    [ "$code" = 0 ] || fail "copy ($code) $kind/$lane: $(printf '%s' "$log" | grep -m1 ERROR)"
    # rclone -v logs one line per file transferred (or skipped under --dry-run).
    ncopy=$(printf '%s\n' "$log" | grep -cE ': (Copied|Skipped copy as --dry-run)')
    printf '%-14s %-14s %8s %8s\n' "$kind" "$lane" "$nremote" "$ncopy"
    kind_n=$((kind_n + ncopy))
    if man=$(rc cat "$remote/MANIFEST.tsv" 2>/dev/null); then
      printf '%s\n' "$man" | awk -F'\t' -v l="$lane" -v k="$kind" \
        'NF > 1 && $1 != "repo" && $1 != "url" {print k "\t" l "\t" $0}' >> "$MAN_TMP"
    elif [ "$nremote" -gt 0 ]; then
      fail "manifest read $kind/$lane (lane has $nremote files)"
    fi
  done < "$TMPD/lanes"
  echo "  $kind: $kind_n files $( [ "$DRY" = 1 ] && echo 'would be copied' || echo copied)"
  total=$((total + kind_n))
done
[ "$nlanes" -gt 0 ] || fail "no lanes found under $BUCKET (source=$SOURCE)"
sort -u "$MAN_TMP" > "$TMPD/sorted"
new_rows=$(wc -l < "$TMPD/sorted" | tr -d ' ')
echo "TOTAL: $total files $( [ "$DRY" = 1 ] && echo 'would be copied' || echo copied); lanes $nlanes; manifest rows: $new_rows"

if [ "$DRY" = 0 ]; then
  old_rows=0
  [ -f "$DEST/MANIFEST.tsv" ] && old_rows=$(( $(wc -l < "$DEST/MANIFEST.tsv") - 1 ))
  [ "$old_rows" -lt 0 ] && old_rows=0
  if [ "$failed" = 1 ]; then
    echo "merged manifest NOT updated (a listing/copy/manifest read failed); kept $old_rows rows" >&2
  elif [ "$new_rows" -lt "$old_rows" ] && [ "$SHRINK" = 0 ]; then
    fail "manifest would shrink $old_rows -> $new_rows rows (pass --allow-shrink to accept)"
  else
    { printf 'kind\tlane\trow\n'; cat "$TMPD/sorted"; } > "$DEST/.MANIFEST.tsv.new" \
      && mv "$DEST/.MANIFEST.tsv.new" "$DEST/MANIFEST.tsv" || fail "writing merged manifest"
    [ "$failed" = 0 ] && echo "merged manifest: $DEST/MANIFEST.tsv ($old_rows -> $new_rows rows)"
  fi
  for kind in android-docs aosp-docs; do
    [ -d "$DEST/$kind" ] && echo "  local $kind: $(find "$DEST/$kind" -type f | wc -l | tr -d ' ') files"
  done
fi

if [ "$PRUNE" = 1 ]; then
  if [ "$DRY" = 1 ] || [ "$failed" = 1 ]; then
    echo "prune-legacy skipped (dry-run or a step failed)"
  else
    for d in "$DEST"/aosp-shard-*; do [ -d "$d" ] && rm -rf "$d" && echo "pruned local $d"; done
  fi
fi
exit "$failed"
