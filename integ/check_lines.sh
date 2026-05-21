#!/usr/bin/env bash
# Assert every expected line in a truth file appears in stdin.
#
# Usage: <command> 2>&1 | bash integ/check_lines.sh integ/truth_x.txt
#
# Truth lines are matched as fixed substrings, so the captured output may
# contain extra/volatile lines (snapshot temp paths, stat mtimes, aggregate
# counts) without breaking the check. Blank lines and lines starting with #
# in the truth file are ignored.
set -euo pipefail

truth="$1"
out="$(cat)"
printf '%s\n' "$out"

rc=0
while IFS= read -r line || [ -n "$line" ]; do
  [ -z "$line" ] && continue
  case "$line" in \#*) continue ;; esac
  if ! printf '%s\n' "$out" | grep -qF -- "$line"; then
    echo "MISSING: $line" >&2
    rc=1
  fi
done <"$truth"

if [ "$rc" -ne 0 ]; then
  echo "FAIL: $truth not satisfied" >&2
fi
exit "$rc"
