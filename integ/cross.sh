#!/usr/bin/env bash
# Bidirectional cross-language snapshot interop over a 4-mount workspace
# (RAM + DISK + REDIS + MinIO). One CLI snapshots; the other loads the tar,
# re-runs read-only commands, and the outputs must match byte-for-byte.
#
# Usage: cross.sh "<py-cli>" "<ts-cli>"
#   e.g. cross.sh "python/.venv/bin/mirage" "node typescript/packages/cli/dist/bin/mirage.js"
set -uo pipefail

PY_CLI="${1:?python mirage cli command}"
TS_CLI="${2:?typescript mirage cli command}"
HERE="$(cd "$(dirname "$0")" && pwd)"
YAML="$HERE/cross.yaml"
fail=0

export CROSS_DISK_ROOT="${CROSS_DISK_ROOT:-/tmp/mirage-cross-disk}"
export CROSS_REDIS_PREFIX="${CROSS_REDIS_PREFIX:-mirage-cross/}"
export MIRAGE_HOME="${MIRAGE_HOME:-/tmp/mirage-cross-home}"
export CROSS_SNAPSHOT_ROOT="$MIRAGE_HOME/snapshots"
mkdir -p "$CROSS_DISK_ROOT" "$CROSS_SNAPSHOT_ROOT"

FINGERPRINTS=(
  "cat /ram/f.txt"
  "cat /disk/g.txt"
  "cat /redis/h.txt"
  "cat /minio/data/x.txt"
  "cat /ram/f.txt /disk/g.txt | wc -l"
  "grep -v '^#' /.bash_history | head -n 1"
  "readlink /ram/l.txt"
  "cat /ram/l.txt"
  "ls -l /ram"
)

freeport() { lsof -ti:8765 2>/dev/null | xargs kill -9 2>/dev/null; sleep 1; }
stdout_of() { jq -r '.stdout // .result.stdout // empty'; }

seed() {
  local cli="$1" id="$2"
  $cli execute -w "$id" -c "echo cross-history-marker" >/dev/null
  $cli execute -w "$id" -c "printf 'ram-a\nram-b\n' > /ram/f.txt" >/dev/null
  $cli execute -w "$id" -c "printf 'disk-1\ndisk-2\ndisk-3\n' > /disk/g.txt" >/dev/null
  $cli execute -w "$id" -c "printf 'redis-x\nredis-y\n' > /redis/h.txt" >/dev/null
  $cli execute -w "$id" -c "printf 'minio-1\nminio-2\n' > /minio/data/x.txt" >/dev/null
  $cli execute -w "$id" -c "printf '1\n2\n3\n4\n5\n' > /guard/big.txt" >/dev/null
  $cli execute -w "$id" -c "ln -s /ram/f.txt /ram/l.txt" >/dev/null
  $cli execute -w "$id" -c "chmod 640 /ram/f.txt && chown 500:dev /ram/f.txt" >/dev/null
  $cli execute -w "$id" -c "touch -t 202601021530 /ram/f.txt" >/dev/null
  $cli execute -w "$id" -c "echo cross-history-marker" >/dev/null
}

# The /guard mount in cross.yaml caps `cat` at 2 lines. Safeguards apply at
# create time (not load) in both languages, so assert on the writer: this
# proves both CLIs parse + apply the same snake_case command_safeguards block.
check_safeguard() {
  local cli="$1" name="$2"
  local lines
  lines="$($cli execute -w cross_w -c "cat /guard/big.txt" | stdout_of | grep -c .)"
  if [ "$lines" == "2" ]; then
    echo "  OK   safeguard caps cat to 2 lines ($name)"
  else
    echo "  FAIL safeguard not applied by $name: got $lines lines (expected 2)"
    fail=1
  fi
}

# cross.yaml sets default_session_id: crosssess. Both CLIs must read the
# snake_case top-level key and seed the workspace's default session with it.
# (TS emits sessionId, Python emits session_id in the create payload.)
check_default_session() {
  local create_json="$1" name="$2"
  local sid
  sid="$(echo "$create_json" | jq -r '.sessions[0].sessionId // .sessions[0].session_id // empty')"
  if [ "$sid" == "crosssess" ]; then
    echo "  OK   default_session_id applied ($name)"
  else
    echo "  FAIL default_session_id not applied by $name: got '$sid' (expected crosssess)"
    fail=1
  fi
}

run_direction() {
  local writer_cli="$1" writer_name="$2" reader_cli="$3" reader_name="$4"
  local tar="$CROSS_SNAPSHOT_ROOT/cross-${writer_name}-to-${reader_name}.tar"
  echo
  echo "===== $writer_name snapshot -> $reader_name load ====="

  freeport
  $writer_cli workspace delete cross_w >/dev/null 2>&1 || true
  local create_json
  create_json="$($writer_cli workspace create "$YAML" --id cross_w)"
  check_default_session "$create_json" "$writer_name"
  seed "$writer_cli" cross_w
  check_safeguard "$writer_cli" "$writer_name"

  local expected=()
  local i
  for i in "${!FINGERPRINTS[@]}"; do
    expected[$i]="$($writer_cli execute -w cross_w -c "${FINGERPRINTS[$i]}" | stdout_of)"
  done
  $writer_cli workspace snapshot cross_w "$tar" >/dev/null
  $writer_cli workspace delete cross_w >/dev/null 2>&1 || true
  freeport

  $reader_cli workspace delete cross_r >/dev/null 2>&1 || true
  $reader_cli workspace load "$tar" "$YAML" --id cross_r >/dev/null
  for i in "${!FINGERPRINTS[@]}"; do
    local got
    got="$($reader_cli execute -w cross_r -c "${FINGERPRINTS[$i]}" | stdout_of)"
    if [ "$got" == "${expected[$i]}" ]; then
      echo "  OK   ${FINGERPRINTS[$i]} => $(printf '%q' "$got")"
    else
      echo "  FAIL ${FINGERPRINTS[$i]}"
      echo "       expected $(printf '%q' "${expected[$i]}")"
      echo "       got      $(printf '%q' "$got")"
      fail=1
    fi
  done
  $reader_cli workspace delete cross_r >/dev/null 2>&1 || true
  freeport
}

run_direction "$PY_CLI" "py" "$TS_CLI" "ts"
run_direction "$TS_CLI" "ts" "$PY_CLI" "py"

if [ "$fail" != "0" ]; then
  echo
  echo "Cross-language snapshot interop FAILED."
  exit 1
fi
echo
echo "Cross-language snapshot interop OK (both directions)."
