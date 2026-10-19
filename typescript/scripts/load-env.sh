#!/usr/bin/env bash
# Source this file to export every key from .env.development as a shell env var.
# Works from any cwd. Resolves .env.development relative to this script's location.
# Parses dotenv format directly (no shell evaluation), so values containing
# `&`, `$`, `(`, etc. don't trip the shell parser.
#
# Usage:
#   source typescript/scripts/load-env.sh    # zsh / bash, from repo root
#   . typescript/scripts/load-env.sh         # POSIX-compatible
#
# After sourcing, run any example from any directory:
#   pnpm tsx ../examples/typescript/vfs/trello/trello_fuse.ts

# Resolve script-relative path (zsh + bash compatible).
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  __HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
elif [ -n "${(%):-%x}" ]; then
  __HERE="$(cd "$(dirname "${(%):-%x}")" && pwd)"
else
  echo "load-env: cannot determine script location (must be sourced)" >&2
  return 1 2>/dev/null || exit 1
fi
__ENV="$(cd "$__HERE/../.." && pwd)/.env.development"
unset __HERE
if [ ! -f "$__ENV" ]; then
  echo "load-env: $__ENV not found" >&2
  unset __ENV
  return 1 2>/dev/null || exit 1
fi

# Parse dotenv lines: KEY=VALUE, skip comments / blanks. Strip optional
# matching surrounding quotes. No shell evaluation, so values containing
# `&`, `$`, `(`, etc. are safe.
__count=0
while IFS= read -r __line || [ -n "$__line" ]; do
  case "$__line" in
    ''|'#'*) continue ;;
  esac
  __key="${__line%%=*}"
  __val="${__line#*=}"
  case "$__key" in
    *[!A-Za-z0-9_]*|'') continue ;;
  esac
  # Strip matching wrapping quotes.
  case "$__val" in
    \"*\") __val="${__val#\"}"; __val="${__val%\"}" ;;
    \'*\') __val="${__val#\'}"; __val="${__val%\'}" ;;
  esac
  export "$__key=$__val"
  __count=$((__count + 1))
done < "$__ENV"

echo "loaded $__count vars from $__ENV"
unset __ENV __line __key __val __count
