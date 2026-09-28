#!/usr/bin/env bash
# POC 10b: pages/min at several in-page concurrencies on one instance.
# Each arm gets its own disjoint URL slice (no cache effects between arms).
# Usage: bash bench.sh <urlfile> <per_arm> <conc...>   -> bench.tsv
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
urls=$1; per=$2; shift 2
out=/tmp/home/bench; mkdir -p "$out"
printf 'conc\turls\tok\tfail\tminutes\tpages_per_min\tstatuses\n' > "$out/bench.tsv"
i=0
for c in "$@"; do
  sed -n "$((i * per + 1)),$(((i + 1) * per))p" "$urls" > "$out/u-$c.txt"
  rm -rf "$out/o-$c"
  s=$(node "$HERE/crawl.mjs" "$out/u-$c.txt" "$out/o-$c" --conc "$c" --batch $((c * 8)) 2>&1 | grep '^SUMMARY')
  ok=$(printf '%s' "$s" | grep -oE 'ok=[0-9]+' | cut -d= -f2); bad=$(printf '%s' "$s" | grep -oE 'fail=[0-9]+' | cut -d= -f2)
  min=$(printf '%s' "$s" | grep -oE 'minutes=[0-9.]+' | cut -d= -f2); ppm=$(printf '%s' "$s" | grep -oE 'pages_per_min=[0-9.]+' | cut -d= -f2)
  st=$(printf '%s' "$s" | grep -oE 'statuses=.*' | cut -d= -f2-)
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$c" "$per" "$ok" "$bad" "$min" "$ppm" "$st" | tee -a "$out/bench.tsv"
  i=$((i + 1))
done
echo BENCH-DONE
