#!/usr/bin/env bash
# Bidirectional cross-language job console interop over one Redis.
# One language runs background jobs in a workspace whose consoles live
# on Redis streams (console_factory / consoleFactory); the other
# attaches to the same keys with its own RedisConsoleStore and must
# follow the job live: it proves it joined mid-run (no ending chunk
# yet), releases the parked job through a signal stream, and reads the
# remaining output plus the ending chunk. The kill round watches a
# killed job's `Killed` marker and `killed` outcome arrive the same way.
# A same-process round per language checks the shell surface end to end
# (`cmd & wait` adopting output) with consoles on Redis.
#
# Usage: console.sh
#   Requires REDIS_URL (defaults to redis://localhost:6379/0), the
#   python venv at python/.venv, and built TypeScript dists
#   (pnpm -r build).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PY="${PY:-$ROOT/python/.venv/bin/python}"
RUN_ID="$RANDOM$RANDOM"
fail=0

run_solo() {
  local lang="$1"
  local prefix="mirage-integ-console-${RUN_ID}-solo-${lang}:"
  echo
  echo "===== [$lang] same-process jobs on a redis console ====="
  if [ "$lang" == "py" ]; then
    "$PY" "$HERE/console.py" solo "$prefix" || fail=1
  else
    (cd "$HERE" && pnpm exec tsx console.ts solo "$prefix") || fail=1
  fi
}

run_stream() {
  local writer="$1" reader="$2" mode="$3"
  local prefix="mirage-integ-console-${RUN_ID}-${mode}-${writer}${reader}:"
  local wrole="write" rrole="read"
  if [ "$mode" == "kill" ]; then
    wrole="kill-write"
    rrole="kill-read"
  fi
  echo
  echo "===== $writer job -> $reader follows live ($mode) ====="
  local wpid
  if [ "$writer" == "py" ]; then
    "$PY" "$HERE/console.py" "$wrole" "$prefix" &
    wpid=$!
    (cd "$HERE" && pnpm exec tsx console.ts "$rrole" "$prefix") || fail=1
  else
    (cd "$HERE" && pnpm exec tsx console.ts "$wrole" "$prefix") &
    wpid=$!
    "$PY" "$HERE/console.py" "$rrole" "$prefix" || fail=1
  fi
  wait "$wpid" || fail=1
}

run_solo py
run_solo ts
run_stream py ts stream
run_stream ts py stream
run_stream py ts kill
run_stream ts py kill

if [ "$fail" != "0" ]; then
  echo
  echo "Cross-language job console interop FAILED."
  exit 1
fi
echo
echo "Cross-language job console interop OK (both directions)."
