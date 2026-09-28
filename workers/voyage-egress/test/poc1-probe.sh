#!/usr/bin/env bash
# POC 1 witness: readiness gate, then /probe on slot 0 (egress IP + one real
# Voyage embedding over connect()+TLS), plus the no-auth negative control.
# Prints one PASS/FAIL line per criterion; exit 0 only if all pass.
set -uo pipefail
BASE="${BASE:-https://voyage-egress.andrwill1995.workers.dev}"
TOKEN="$(tr -d '\n' < "$HOME/.drew/voyage-egress.token")"
fail=0
check() { if [ "$2" = "1" ]; then echo "PASS $1: $3"; else echo "FAIL $1: $3"; fail=1; fi; }

for i in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz")" = "200" ] && break
  sleep 2
done
check ready "$([ "$i" -lt 30 ] && echo 1 || echo 0)" "healthz 200 after $i tries"

code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/probe?slot=0")
check no-auth-401 "$([ "$code" = "401" ] && echo 1 || echo 0)" "unauthenticated /probe -> $code"

body=$(curl -s --max-time 150 -H "Authorization: Bearer $TOKEN" "$BASE/probe?slot=0")
echo "probe: $body"
status=$(printf '%s' "$body" | jq -r '.status // empty')
dims=$(printf '%s' "$body" | jq -r '.dims // 0')
ip=$(printf '%s' "$body" | jq -r '.egress_ip // empty')
tok=$(printf '%s' "$body" | jq -r '.usage_tokens // empty')

check voyage-200 "$([ "$status" = "200" ] && echo 1 || echo 0)" "status=$status"
check dims-1024 "$([ "$dims" = "1024" ] && echo 1 || echo 0)" "dims=$dims"
check usage-numeric "$(printf '%s' "$tok" | grep -Eq '^[0-9]+$' && echo 1 || echo 0)" "usage_tokens=$tok"
check egress-ip "$(printf '%s' "$ip" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$|:' && echo 1 || echo 0)" "egress_ip=$ip"
check no-key-in-body "$(printf '%s' "$body" | grep -q 'pa-' && echo 0 || echo 1)" "response has no pa- token"

exit $fail
