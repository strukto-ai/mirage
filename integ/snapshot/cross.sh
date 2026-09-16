#!/usr/bin/env bash
# Drive the cross-language snapshot battery in all four directions.
#
# Each arm builds its own world from the same case document, so the
# question asked is the one that matters: can the other language read
# what this one wrote? A snapshot carries content for the resources
# that hold it (RAM and redis restore through load_state) and a
# fingerprint for the ones that do not, so an object store the reader
# seeded from the same fixture matches by construction and a live-only
# mount is read live.
#
# Every arm records what it observed rather than asserting a golden, so
# the comparison is the assertion: a plane one language carries and the
# other drops shows up as a diff without a per-case expectation for it.
# A case's own `expect` blocks pin the absolute truths that a matching
# pair of wrong answers would otherwise hide.
#
# Usage: integ/snapshot/cross.sh [--strict] [--case ID]
#   --strict  a skipped case fails the run (what CI passes)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="$ROOT/python/.venv/bin/python"
TSX="$ROOT/integ/node_modules/.bin/tsx"
WORK="${SNAPSHOT_WORK:-$(mktemp -d)}"
STRICT=0
ONLY=()

while [ $# -gt 0 ]; do
  case "$1" in
    --strict) STRICT=1; shift ;;
    --case) ONLY=(--case "$2"); shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

for tool in "$PY" "$TSX"; do
  if [ ! -x "$tool" ]; then
    echo "missing $tool; build the python venv and run pnpm install in integ/" >&2
    exit 2
  fi
done

fail=0
skips=0

# One direction: writer writes into its own directory, reader loads
# those tars into a world of its own and records beside them.
run_direction() {
  local writer="$1" reader="$2"
  local out="$WORK/$writer-to-$reader"
  mkdir -p "$out/tars" "$out/read"
  echo "== $writer -> $reader"
  arm "$writer" write "$out/tars" "$out/tars" || fail=1
  arm "$reader" read "$out/tars" "$out/read" || fail=1
  compare "$writer" "$reader" "$out"
}

arm() {
  local lang="$1" mode="$2" dir="$3" out="$4"
  local run="snap-$(date +%s)-$RANDOM"
  if [ "$lang" = python ]; then
    (cd "$ROOT" && "$PY" integ/snapshot/run.py "$mode" "$run" "$dir" --out "$out" "${ONLY[@]+"${ONLY[@]}"}")
  else
    (cd "$ROOT/integ" && "$TSX" snapshot/run.ts "$mode" "$run" "$dir" --out "$out" "${ONLY[@]+"${ONLY[@]}"}")
  fi
}

# The comparison: the writer's record against the reader's, per case.
compare() {
  local writer="$1" reader="$2" out="$3"
  local wrote read_back id
  shopt -s nullglob
  for wrote in "$out/tars"/*."$writer".json; do
    id="$(basename "$wrote" ".$writer.json")"
    read_back="$out/read/$id.$reader.json"
    if [ ! -f "$read_back" ]; then
      echo "   SKIP $id: $reader recorded nothing"
      skips=$((skips + 1))
      continue
    fi
    if diff -u "$wrote" "$read_back" > "$out/$id.diff"; then
      echo "   ok $id"
    else
      echo "   FAIL $id: what $reader read is not what $writer wrote"
      sed -n '1,40p' "$out/$id.diff"
      fail=1
    fi
  done
  for wrote in "$out/tars"/*.skip; do
    id="$(basename "$wrote" .skip)"
    echo "   SKIP $id: needs $(cat "$wrote")"
    skips=$((skips + 1))
  done
  shopt -u nullglob
}

run_direction python typescript
run_direction typescript python
run_direction python python
run_direction typescript typescript

echo
if [ "$skips" -gt 0 ]; then
  echo "$skips case-direction(s) skipped for a missing service"
  if [ "$STRICT" = 1 ]; then
    echo "--strict: a skipped case is a failure" >&2
    fail=1
  fi
fi
if [ "$fail" = 0 ]; then
  echo "cross-language snapshot battery: every direction agrees"
else
  echo "cross-language snapshot battery: FAILED (work kept in $WORK)" >&2
fi
exit "$fail"
