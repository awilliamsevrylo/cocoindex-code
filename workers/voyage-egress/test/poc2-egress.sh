#!/usr/bin/env bash
# POC 2 witness: 12 slots x 5 interleaved rounds -> each slot sticky (1 IP)
# and all slots distinct (12 IPs); plus a positive control on fresh DO names
# proving the instrument can see distinct IPs at all. No Voyage spend.
set -uo pipefail
BASE="${BASE:-https://voyage-egress.andrwill1995.workers.dev}"
TOKEN="$(tr -d '\n' < "$HOME/.drew/voyage-egress.token")"
SLOTS="${SLOTS:-12}"
ROUNDS="${ROUNDS:-5}"
OUT="$(mktemp)"
fail=0
check() { if [ "$2" = "1" ]; then echo "PASS $1: $3"; else echo "FAIL $1: $3"; fail=1; fi; }
egress() { curl -s --max-time 30 -H "Authorization: Bearer $TOKEN" "$BASE/egress?$1" | jq -r '.egress_ip // "ERR"'; }

# Positive control first: fresh names must NOT all collapse to one IP.
ctl=""
for i in 1 2 3 4 5; do ctl="$ctl $(egress "name=ctl$RANDOM$RANDOM")"; done
ctl_distinct=$(printf '%s\n' $ctl | sort -u | grep -vc ERR)
check control-sees-distinct "$([ "$ctl_distinct" -gt 1 ] && echo 1 || echo 0)" "5 fresh DOs -> $ctl_distinct distinct:$ctl"

# Interleaved: each round visits every slot once.
for r in $(seq 1 "$ROUNDS"); do
  for s in $(seq 0 $((SLOTS - 1))); do
    printf '%02d %s\n' "$s" "$(egress "slot=$s&pinned=${PINNED:-0}")" >> "$OUT"
  done
done

errs=$(grep -c ' ERR$' "$OUT")
check no-errors "$([ "$errs" = "0" ] && echo 1 || echo 0)" "$errs failed calls of $((SLOTS * ROUNDS))"

nonsticky=0
for s in $(seq 0 $((SLOTS - 1))); do
  n=$(awk -v s="$(printf '%02d' "$s")" '$1==s {print $2}' "$OUT" | sort -u | wc -l | tr -d ' ')
  ip=$(awk -v s="$(printf '%02d' "$s")" '$1==s {print $2}' "$OUT" | sort -u | tr '\n' ' ')
  echo "  slot $(printf '%02d' "$s"): $n distinct -> $ip"
  [ "$n" = "1" ] || nonsticky=$((nonsticky + 1))
done
check sticky "$([ "$nonsticky" = "0" ] && echo 1 || echo 0)" "$nonsticky of $SLOTS slots changed IP across $ROUNDS rounds"

# One representative IP per slot; distinct count across slots.
reps=$(awk '{print $1, $2}' "$OUT" | sort -u -k1,1 | awk '{print $2}')
distinct=$(printf '%s\n' $reps | sort -u | wc -l | tr -d ' ')
check distinct "$([ "$distinct" = "$SLOTS" ] && echo 1 || echo 0)" "$distinct distinct IPs across $SLOTS slots"
if [ "$distinct" != "$SLOTS" ]; then
  echo "  collisions:"
  awk '{print $1, $2}' "$OUT" | sort -u -k1,1 | awk '{c[$2]=c[$2]" "$1} END {for (ip in c) if (split(c[ip], a, " ") > 1) print "   " ip ":" c[ip]}'
fi

cp "$OUT" /tmp/poc2-egress-raw.txt
exit $fail
