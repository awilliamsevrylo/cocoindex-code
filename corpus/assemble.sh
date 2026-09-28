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
# Usage: bash corpus/assemble.sh [--dry-run] [--source new|legacy] [--prune-legacy]
#   --dry-run       list what would be copied (rclone --dry-run); writes nothing
#   --source legacy read the old aosp-shard-NN/{android-docs,aosp-docs} layout
#                   (the Jina-era crawl) into the same new local layout
#   --prune-legacy  after a successful copy, delete the LOCAL legacy
#                   $DEST/aosp-shard-* dirs (off by default; never touches Wasabi)
# Env: CORPUS_DEST (default ~/PROJECTS/aosp-docs), RCLONE_CONF, CORPUS_BUCKET
set -uo pipefail

CONF="${RCLONE_CONF:-$HOME/.drew/rclone-wasabimb.conf}"
BUCKET="${CORPUS_BUCKET:-wasabimb:drew-aosp-docs-20260928}"
DEST="${CORPUS_DEST:-$HOME/PROJECTS/aosp-docs}"
DRY=0; SOURCE=new; PRUNE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --source) SOURCE="$2"; shift ;;
    --prune-legacy) PRUNE=1 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -r "$CONF" ] || { echo "rclone config not readable: $CONF" >&2; exit 2; }
rc() { rclone --config "$CONF" "$@"; }

# name<TAB>remote-prefix pairs, one per lane, per source kind.
lanes() { # kind -> "local_name<TAB>remote_path" lines
  local kind=$1
  if [ "$SOURCE" = legacy ]; then
    rc lsf --dirs-only "$BUCKET" | grep -E '^aosp-shard-[0-9]+/$' | tr -d / | while read -r l; do
      printf '%s\t%s\n' "$l" "$BUCKET/$l/$kind"
    done
  else
    local top; [ "$kind" = android-docs ] && top=android-docs-pw || top=aosp-docs-v2
    rc lsf --dirs-only "$BUCKET/$top" 2>/dev/null | tr -d / | while read -r l; do
      [ -n "$l" ] && printf '%s\t%s\n' "$l" "$BUCKET/$top/$l"
    done
  fi
}

FLAGS=(--update --transfers 32 --checkers 32 --fast-list --exclude 'MANIFEST.tsv' --exclude '.DS_Store')
[ "$DRY" = 1 ] && FLAGS+=(--dry-run)

mkdir -p "$DEST"
MAN_TMP="$(mktemp "${TMPDIR:-/tmp}/assemble-manifest.XXXXXX")"
trap 'rm -f "$MAN_TMP"' EXIT
total=0; failed=0
printf '%-14s %-14s %8s %8s\n' kind lane remote would_copy
for kind in android-docs aosp-docs; do
  kind_n=0
  while IFS=$'\t' read -r lane remote; do
    [ -z "$lane" ] && continue
    nremote=$(rc lsf -R --files-only --exclude MANIFEST.tsv "$remote" 2>/dev/null | wc -l | tr -d ' ')
    log=$(rc copy "$remote" "$DEST/$kind" "${FLAGS[@]}" -v 2>&1); code=$?
    [ "$code" = 0 ] || { failed=1; echo "  copy FAILED ($code) $kind/$lane: $(printf '%s' "$log" | grep -m1 ERROR)"; }
    # rclone -v logs one line per file transferred (or skipped under --dry-run).
    ncopy=$(printf '%s\n' "$log" | grep -cE ': (Copied|Skipped copy as --dry-run)')
    printf '%-14s %-14s %8s %8s\n' "$kind" "$lane" "$nremote" "$ncopy"
    kind_n=$((kind_n + ncopy))
    rc cat "$remote/MANIFEST.tsv" 2>/dev/null \
      | awk -F'\t' -v l="$lane" -v k="$kind" 'NF > 1 && $1 != "repo" && $1 != "url" {print k "\t" l "\t" $0}' >> "$MAN_TMP"
  done < <(lanes "$kind")
  echo "  $kind: $kind_n files $( [ "$DRY" = 1 ] && echo 'would be copied' || echo copied)"
  total=$((total + kind_n))
done
echo "TOTAL: $total files $( [ "$DRY" = 1 ] && echo 'would be copied' || echo copied); manifest rows: $(wc -l < "$MAN_TMP" | tr -d ' ')"

if [ "$DRY" = 0 ]; then
  { printf 'kind\tlane\trow\n'; sort -u "$MAN_TMP"; } > "$DEST/MANIFEST.tsv"
  echo "merged manifest: $DEST/MANIFEST.tsv"
  for kind in android-docs aosp-docs; do
    [ -d "$DEST/$kind" ] && echo "  local $kind: $(find "$DEST/$kind" -type f | wc -l | tr -d ' ') files"
  done
fi

if [ "$PRUNE" = 1 ]; then
  if [ "$DRY" = 1 ] || [ "$failed" = 1 ]; then
    echo "prune-legacy skipped (dry-run or a copy failed)"
  else
    for d in "$DEST"/aosp-shard-*; do [ -d "$d" ] && rm -rf "$d" && echo "pruned local $d"; done
  fi
fi
exit "$failed"
