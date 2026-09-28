#!/usr/bin/env bash
# POC 5 live witness: concurrent single-batch requests spread over the slots
# (the old per-request pointer sent every one of them to slot 00).
# Pass: >= MIN_DISTINCT distinct serving slots across N concurrent requests.
set -uo pipefail
BASE="${BASE:-https://voyage-egress.andrwill1995.workers.dev}"
TOKEN="$(tr -d '\n' < "$HOME/.drew/voyage-egress.token")"
N="${N:-26}"
MIN_DISTINCT="${MIN_DISTINCT:-10}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
fail=0
check() { if [ "$2" = "1" ]; then echo "PASS $1: $3"; else echo "FAIL $1: $3"; fail=1; fi; }
post() { curl -s --max-time 120 -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$1" "$BASE/v1/embeddings"; }

# Readiness: the new version reports voyage_egress.slots.
for i in $(seq 1 40); do
  s=$(post '{"model":"voyage-4-lite","input":["ready probe"]}' | jq -c '.voyage_egress.slots // empty')
  [ -n "$s" ] && break; sleep 3
done
check new-version-live "$([ -n "$s" ] && echo 1 || echo 0)" "slots field present after $i tries ($s)"

for i in $(seq 1 "$N"); do
  post "{\"model\":\"voyage-4-lite\",\"input\":[\"concurrent spread probe $i $RANDOM\"]}" > "$OUT/$i.json" &
done
wait
ok=$(cat "$OUT"/*.json | jq -s '[.[] | select(.data)] | length')
slots=$(cat "$OUT"/*.json | jq -s -c '[.[] | .voyage_egress.slots[]?] | sort')
distinct=$(printf '%s' "$slots" | jq 'unique | length')
maxper=$(printf '%s' "$slots" | jq 'group_by(.) | map(length) | max')
echo "served slots: $slots"
check all-succeeded "$([ "$ok" = "$N" ] && echo 1 || echo 0)" "$ok/$N returned vectors"
check spread "$([ "${distinct:-0}" -ge "$MIN_DISTINCT" ] && echo 1 || echo 0)" "distinct slots=$distinct (need >= $MIN_DISTINCT), max calls on one slot=$maxper"
exit $fail
