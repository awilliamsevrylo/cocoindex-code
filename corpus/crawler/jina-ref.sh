#!/usr/bin/env bash
# Fetch the keyless Jina Markdown for a URL list into <refdir> (same path
# scheme as crawl.mjs) — the reference that check-quality.mjs scores recall
# against. Paced for Jina's free tier.
# Usage: bash jina-ref.sh <urlfile> <refdir>
set -u
urls=$1; ref=$2
while read -r u; do
  [ -z "$u" ] && continue
  p=$(node -e 'const u=process.argv[1];console.log((new URL(u).pathname.replace(/^\//,"").replace(/\/$/,"")||"index").split("/").map(s=>s.replace(/[^a-zA-Z0-9._-]/g,"_")).join("/")+".md")' "$u")
  mkdir -p "$(dirname "$ref/$p")"
  code=$(curl -s -o "$ref/$p" -w '%{http_code}' -H 'x-respond-with: markdown' \
    -H 'x-remove-selector: header, footer, nav, devsite-header, devsite-footer-linkboxes, .devsite-banner, .nocontent' \
    "https://r.jina.ai/$u")
  [ "$code" = 200 ] || { echo "ref $code $u"; rm -f "$ref/$p"; }
  sleep 3
done < "$urls"
echo "ref files: $(find "$ref" -name '*.md' | wc -l)"
