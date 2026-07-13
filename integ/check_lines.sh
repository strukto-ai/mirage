#!/usr/bin/env bash
# Assert every expected line in a truth file appears in stdin.
#
# Usage: <command> 2>&1 | bash integ/check_lines.sh integ/truth_x.txt
#
# Truth lines are matched as fixed substrings (grep -aF), so the captured
# output may contain extra/volatile lines (snapshot temp paths, stat mtimes,
# aggregate counts) or even binary bytes without breaking the check. Blank
# lines and lines starting with # in the truth file are ignored.
set -euo pipefail

truth="$1"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
# Strip CR on both sides: Windows runners check the truth file out with
# CRLF (core.autocrlf) and Windows Python writes CRLF output, either of
# which would make every fixed-substring probe carry a stray \r.
tr -d '\r' >"$tmp"

rc=0
matched=0
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  [ -z "$line" ] && continue
  case "$line" in \#*) continue ;; esac
  if grep -aqF -- "$line" "$tmp"; then
    matched=$((matched + 1))
  else
    echo "MISSING: $line" >&2
    rc=1
  fi
done <"$truth"

bytes="$(wc -c <"$tmp" | tr -d ' ')"
if [ "$rc" -ne 0 ]; then
  echo "FAIL: $truth not satisfied (${bytes} bytes captured)" >&2
else
  echo "OK: $truth (${matched} lines matched, ${bytes} bytes captured)"
fi
exit "$rc"
