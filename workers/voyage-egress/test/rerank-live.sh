#!/usr/bin/env bash
# Live probe for POST /v1/rerank plus a /v1/embeddings regression check.
# Token comes from ~/.drew/voyage-egress.token — never echoed.
set -uo pipefail
BASE="${BASE:-https://voyage-egress.andrwill1995.workers.dev}"
TOKEN="$(tr -d '\n' < "$HOME/.drew/voyage-egress.token")"
fail=0
check() { if [ "$2" = "1" ]; then echo "PASS $1: $3"; else echo "FAIL $1: $3"; fail=1; fi; }
post() { curl -s --max-time 150 -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$2" "$BASE$1"; }

r=$(post /v1/rerank '{"query":"android permissions","documents":["permission model overview","USB host mode","WorkManager jobs"],"model":"rerank-2.5","top_k":2}')
code=$(printf '%s' "$r" | jq -r '.data | type' 2>/dev/null)
n=$(printf '%s' "$r" | jq '.data | length' 2>/dev/null)
idx=$(printf '%s' "$r" | jq -c '[.data[].index]' 2>/dev/null)
echo "rerank: n=$n idx=$idx"
check rerank-200 "$([ "$code" = "array" ] && echo 1 || echo 0)" "data is array n=$n"
check rerank-index "$([ -n "$idx" ] && [ "$idx" != "null" ] && echo 1 || echo 0)" "indexes=$idx"

r=$(post /v1/embeddings '{"model":"voyage/voyage-4-large","input":["regression probe"]}')
dims=$(printf '%s' "$r" | jq '[.data[].embedding | length] | unique | join(",")' -r 2>/dev/null)
echo "embeddings: dims=$dims"
check embeddings-200-dims-1024 "$([ "$dims" = "1024" ] && echo 1 || echo 0)" "dims=$dims"

exit $fail
