#!/usr/bin/env bash
set -euo pipefail

tool="$1"
shift

# Leading dash args are tool flags; the rest are repo-relative files from
# pre-commit, rebased to the typescript/ package root.
args=()
for a in "$@"; do
  if [[ "$a" == -* ]]; then
    args+=("$a")
  else
    args+=("${a#typescript/}")
  fi
done

cd "$(dirname "$0")/.."
exec pnpm exec "$tool" "${args[@]}"
