#!/usr/bin/env bash
set -euo pipefail

# --selftest runs this script against a fake eslint that records each call's
# files and fails on one named `bad`: 500 files stay one call, 501 become two
# that cover every file once, and a failure in either half fails the run.
if [[ "${1:-}" == --selftest ]]; then
  root="$(mktemp -d)"
  trap 'rm -rf "$root"' EXIT
  mkdir -p "$root/scripts" "$root/node_modules/.bin" "$root/calls"
  cp "$0" "$root/scripts/precommit-run.sh"
  printf '%s\n' '#!/usr/bin/env bash' \
    'printf "%s\n" "$@" | grep -v "^-" >"calls/$$"' \
    '! grep -qx bad "calls/$$"' >"$root/node_modules/.bin/eslint"
  chmod +x "$root/node_modules/.bin/eslint"
  expect() {
    local calls="$1" status="$2" rc=0 want
    shift 2
    rm -f "$root/calls/"*
    "$root/scripts/precommit-run.sh" eslint --fix "$@" || rc=$?
    local got=("$root/calls/"*)
    want="$(printf '%s\n' "${@#typescript/}" | sort)"
    if [[ ${#got[@]} -ne $calls || "$(cat "${got[@]}" | sort)" != "$want" ]] ||
      [[ ($status == pass && $rc -ne 0) || ($status == fail && $rc -eq 0) ]]; then
      echo "precommit-run selftest: $# files gave ${#got[@]} calls and exit $rc," \
        "want $calls calls and $status" >&2
      exit 1
    fi
  }
  many=($(seq -f 'typescript/f%g' 500))
  expect 1 pass "${many[@]}"
  expect 2 pass "${many[@]}" typescript/f501
  expect 2 fail typescript/bad "${many[@]}"
  expect 2 fail "${many[@]}" typescript/bad
  echo "precommit-run selftest: ok"
  exit 0
fi

tool="$1"
shift

# Leading dash args are tool flags; the rest are repo-relative files from
# pre-commit, rebased to the typescript/ package root.
flags=()
files=()
for a in "$@"; do
  if [[ "$a" == -* ]]; then
    flags+=("$a")
  else
    files+=("${a#typescript/}")
  fi
done

cd "$(dirname "$0")/.."
# The installed bin, not `pnpm exec`: pnpm stays resident as a second node
# process per batch and picks its own version through corepack.
bin="node_modules/.bin/$tool"

# Every eslint process builds the TypeScript program of each package it
# lints, so the hook is require_serial and a large batch is halved here
# instead: pre-commit's split into one batch per CPU rebuilt core's program
# fourteen times. Over every file that took 87 s and peaked at 18 GB; two
# halves take 39 s and 6 GB.
# V8's default heap on the 16 GB CI runner is about 4 GB, and over every file
# the half holding node and the packages after it outgrew it (2026-11-26), so
# eslint gets 6 GB: both halves still fit the runner.
if [[ "$tool" == eslint ]]; then
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=6144"
fi
if [[ "$tool" == eslint && ${#files[@]} -gt 500 ]]; then
  half=$(((${#files[@]} + 1) / 2))
  "$bin" "${flags[@]}" "${files[@]:0:half}" &
  first=$!
  rc=0
  "$bin" "${flags[@]}" "${files[@]:half}" || rc=$?
  wait "$first" || rc=$?
  exit "$rc"
fi
exec "$bin" "${flags[@]}" "${files[@]}"
