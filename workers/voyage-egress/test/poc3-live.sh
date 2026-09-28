#!/usr/bin/env bash
# POC 3 live witness: real /v1/embeddings requests through the deployed router.
# Pass: 3-input doc request -> 3 vectors, dims 1024, indices 0..2 in order;
# query route works; `voyage/` prefix accepted; bad model surfaces an error.
set -uo pipefail
BASE="${BASE:-https://voyage-egress.andrwill1995.workers.dev}"
TOKEN="$(tr -d '\n' < "$HOME/.drew/voyage-egress.token")"
fail=0
check() { if [ "$2" = "1" ]; then echo "PASS $1: $3"; else echo "FAIL $1: $3"; fail=1; fi; }
post() { curl -s --max-time 150 -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$2" "$BASE$1"; }

# Readiness gate on the route under test (a fresh deploy can serve the old
# version for a while — /healthz alone does not prove the new route is live).
for i in $(seq 1 30); do
  c=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' -d '{}' "$BASE/v1/embeddings")
  [ "$c" = "400" ] && break   # handler reached: empty body rejected as 400
  sleep 3
done
check route-ready "$([ "$c" = "400" ] && echo 1 || echo 0)" "/v1/embeddings handler reached after $i tries (code $c)"

r=$(post /v1/embeddings '{"model":"voyage/voyage-4-large","input":["Android runtime permissions","USB host mode overview","WorkManager background tasks"]}')
n=$(printf '%s' "$r" | jq '.data | length')
dims=$(printf '%s' "$r" | jq '[.data[].embedding | length] | unique | join(",")' -r)
idx=$(printf '%s' "$r" | jq -c '[.data[].index]')
tok=$(printf '%s' "$r" | jq '.usage.total_tokens')
echo "doc: n=$n dims=$dims idx=$idx tokens=$tok egress=$(printf '%s' "$r" | jq -c '.voyage_egress')"
check three-vectors "$([ "$n" = "3" ] && echo 1 || echo 0)" "n=$n"
check dims-1024 "$([ "$dims" = "1024" ] && echo 1 || echo 0)" "dims=$dims"
check order "$([ "$idx" = "[0,1,2]" ] && echo 1 || echo 0)" "indices=$idx"
check usage "$(printf '%s' "$tok" | grep -Eq '^[1-9][0-9]*$' && echo 1 || echo 0)" "total_tokens=$tok"

q=$(post /v1/embeddings/query '{"model":"voyage-4-large","input":"how do I request a runtime permission"}')
qd=$(printf '%s' "$q" | jq '.data[0].embedding | length')
check query-route "$([ "$qd" = "1024" ] && echo 1 || echo 0)" "query dims=$qd (bare model id)"

# Retrieval sanity: the permission query must score the permission doc highest.
best=$(jq -n --argjson d "$r" --argjson q "$q" '
  def dot(a;b): [a, b] | transpose | map(.[0] * .[1]) | add;
  [$d.data[] | {i: .index, s: dot(.embedding; $q.data[0].embedding)}] | max_by(.s) | .i')
check retrieval-sanity "$([ "$best" = "0" ] && echo 1 || echo 0)" "best doc index for permission query = $best (expect 0)"

bad=$(post /v1/embeddings '{"model":"voyage-does-not-exist","input":["x"]}')
be=$(printf '%s' "$bad" | jq -r '.error // empty')
check bad-model-surfaces "$([ -n "$be" ] && echo 1 || echo 0)" "error=${be:0:80}"

check no-key-in-body "$(printf '%s%s%s' "$r" "$q" "$bad" | grep -q 'pa-' && echo 0 || echo 1)" "no pa- token in any response"
exit $fail
