#!/usr/bin/env bash
# Bidirectional cross-language WorkspaceStateStore interop over one Redis.
# One language populates all four control planes (namespace symlink,
# observer history, session grants, workspace metadata); the other attaches
# with only the store config + workspace id and must see identical state:
# same discovery record, same symlink, same history, and the narrowed
# session's grants enforced.
#
# With STORE_S3=1 the whole battery runs a second time with the
# sessions+meta group on S3 (conditional-PUT CAS against MinIO) as the
# workspace group override, exercising the exact same checks.
#
# Usage: state_store.sh
#   Requires REDIS_URL (defaults to redis://localhost:6379/0), the python
#   venv at python/.venv, and built TypeScript dists (pnpm -r build).
#   The s3 round additionally needs a reachable S3 endpoint
#   (STORE_S3_ENDPOINT, default http://localhost:9000) with an existing
#   bucket (STORE_S3_BUCKET, default mirage-state).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PY="${PY:-$ROOT/python/.venv/bin/python}"
RUN_ID="$RANDOM$RANDOM"
fail=0

run_direction() {
  local backend="$1" writer_name="$2" reader_name="$3"
  local prefix="mirage-integ-xstore-${RUN_ID}-${backend}-${writer_name}:"
  echo
  echo "===== [$backend] $writer_name store write -> $reader_name attach ====="
  if [ "$writer_name" == "py" ]; then
    "$PY" "$HERE/state_store.py" write "$prefix" || fail=1
    (cd "$HERE" && pnpm exec tsx state_store.ts read "$prefix") || fail=1
  else
    (cd "$HERE" && pnpm exec tsx state_store.ts write "$prefix") || fail=1
    "$PY" "$HERE/state_store.py" read "$prefix" || fail=1
  fi
}

run_concurrent() {
  local backend="$1"
  local prefix="mirage-integ-xstore-${RUN_ID}-${backend}-hammer:"
  local rounds=25
  echo
  echo "===== [$backend] concurrent py+ts CAS hammer ====="
  "$PY" "$HERE/state_store.py" hammer "$prefix" "$rounds" &
  local hammer_pid=$!
  (cd "$HERE" && pnpm exec tsx state_store.ts hammer "$prefix" "$rounds") || fail=1
  wait "$hammer_pid" || fail=1
  "$PY" "$HERE/state_store.py" cas-verify "$prefix" "$rounds" || fail=1
  (cd "$HERE" && pnpm exec tsx state_store.ts cas-verify "$prefix" "$rounds") || fail=1
}

run_battery() {
  local backend="$1"
  export STORE_BACKEND="$backend"
  run_direction "$backend" "py" "ts"
  run_direction "$backend" "ts" "py"
  run_concurrent "$backend"
}

run_battery "redis"
if [ "${STORE_S3:-0}" == "1" ]; then
  run_battery "s3"
fi

if [ "$fail" != "0" ]; then
  echo
  echo "Cross-language state store interop FAILED."
  exit 1
fi
echo
echo "Cross-language state store interop OK (both directions)."
