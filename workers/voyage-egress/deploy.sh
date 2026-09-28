#!/usr/bin/env bash
# Deploy voyage-slot (DO host) then voyage-egress (router) to the PERSONAL
# account, and load secrets. Keys are streamed from ~/.drew/voyage.keys via
# stdin — key tokens only (labels stripped), never echoed or written to disk.
# Usage: bash deploy.sh [--secrets]   (--secrets re-uploads both secrets)
set -euo pipefail
cd "$(dirname "$0")"

ENVF="$HOME/PROJECTS/home-md-index/.env"
export CLOUDFLARE_API_TOKEN="$(grep '^CF_API_TOKEN=' "$ENVF" | cut -d= -f2 | tr -d '"')"
export CLOUDFLARE_ACCOUNT_ID="$(grep '^CF_ACCOUNT_ID=' "$ENVF" | cut -d= -f2 | tr -d '"')"
case "$CLOUDFLARE_ACCOUNT_ID" in fe60f980*) ;; *) echo "refusing: not the PERSONAL account"; exit 2 ;; esac

KEYS_FILE="$HOME/.drew/voyage.keys"
TOKEN_FILE="$HOME/.drew/voyage-egress.token"

keys_only() { grep -v '^[[:space:]]*#' "$KEYS_FILE" | awk '$1 ~ /^pa-/ {print $1}'; }

if [ ! -f "$TOKEN_FILE" ]; then
  umask 077
  openssl rand -hex 32 > "$TOKEN_FILE"
  echo "minted worker token -> $TOKEN_FILE (0600)"
fi

echo "== deploy voyage-slot (DO host)"
npx wrangler deploy -c slot/wrangler.jsonc 2>&1 | grep -E 'Uploaded|Deployed|Current Version|error' || true

echo "== deploy voyage-egress (router)"
npx wrangler deploy -c wrangler.jsonc 2>&1 | grep -E 'Uploaded|Deployed|https://|Current Version|error' || true

if [ "${1:-}" = "--secrets" ]; then
  echo "== secrets: VOYAGE_KEYS ($(keys_only | wc -l | tr -d ' ') keys) on voyage-slot"
  keys_only | npx wrangler secret put VOYAGE_KEYS -c slot/wrangler.jsonc 2>&1 | grep -E 'Success|error' || true
  echo "== secrets: WORKER_TOKEN on voyage-egress"
  tr -d '\n' < "$TOKEN_FILE" | npx wrangler secret put WORKER_TOKEN -c wrangler.jsonc 2>&1 | grep -E 'Success|error' || true
fi
