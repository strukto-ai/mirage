#!/usr/bin/env bash
set -euo pipefail

: "${SUITES:?SUITES must contain the resolved suite names}"

case "${1:-}" in
  start)
    integ/scripts/background.sh start json-python '
      ./python/.venv/bin/python integ/runtime/run.py $SUITES'
    # Only this suite drops a shared database. Everything else owns its
    # workspace, run id and ports, so both hosts can run at once.
    integ/scripts/background.sh start json-typescript '
      suites=()
      for suite in $SUITES; do
        if [ "$suite" != backend/mongodb ]; then suites+=("$suite"); fi
      done
      if [ "${#suites[@]}" -gt 0 ]; then
        cd integ
        pnpm exec tsx runtime/run.ts "${suites[@]}"
      fi'
    ;;
  wait)
    status=0
    integ/scripts/background.sh wait json-python || status=1
    integ/scripts/background.sh wait json-typescript || status=1
    if [[ " $SUITES " == *" backend/mongodb "* ]]; then
      (cd integ && pnpm exec tsx runtime/run.ts backend/mongodb) || status=1
    fi
    exit "$status"
    ;;
  *)
    echo 'usage: parallel.sh start | wait' >&2
    exit 2
    ;;
esac
