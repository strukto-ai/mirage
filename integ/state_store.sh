#!/usr/bin/env bash
# Bidirectional cross-language WorkspaceStateStore interop over one Redis.
# One language populates all four control planes (namespace symlink,
# observer history, session grants, workspace metadata); the other attaches
# with only the store config + workspace id and must see identical state:
# same discovery record, same symlink, same history, and the narrowed
# session's grants enforced.
#
# Usage: state_store.sh
#   Requires REDIS_URL (defaults to redis://localhost:6379/0), the python
#   venv at python/.venv, and built TypeScript dists (pnpm -r build).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PY="${PY:-$ROOT/python/.venv/bin/python}"
RUN_ID="$RANDOM$RANDOM"
fail=0

run_direction() {
  local writer_name="$1" reader_name="$2"
  local prefix="mirage-integ-xstore-${RUN_ID}-${writer_name}:"
  echo
  echo "===== $writer_name store write -> $reader_name attach ====="
  if [ "$writer_name" == "py" ]; then
    "$PY" "$HERE/state_store.py" write "$prefix" || fail=1
    (cd "$HERE" && pnpm exec tsx state_store.ts read "$prefix") || fail=1
  else
    (cd "$HERE" && pnpm exec tsx state_store.ts write "$prefix") || fail=1
    "$PY" "$HERE/state_store.py" read "$prefix" || fail=1
  fi
}

run_concurrent() {
  local prefix="mirage-integ-xstore-${RUN_ID}-hammer:"
  local rounds=25
  echo
  echo "===== concurrent py+ts CAS hammer ====="
  "$PY" "$HERE/state_store.py" hammer "$prefix" "$rounds" &
  local hammer_pid=$!
  (cd "$HERE" && pnpm exec tsx state_store.ts hammer "$prefix" "$rounds") || fail=1
  wait "$hammer_pid" || fail=1
  "$PY" "$HERE/state_store.py" cas-verify "$prefix" "$rounds" || fail=1
  (cd "$HERE" && pnpm exec tsx state_store.ts cas-verify "$prefix" "$rounds") || fail=1
}

run_direction "py" "ts"
run_direction "ts" "py"
run_concurrent

if [ "$fail" != "0" ]; then
  echo
  echo "Cross-language state store interop FAILED."
  exit 1
fi
echo
echo "Cross-language state store interop OK (both directions)."
