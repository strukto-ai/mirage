#!/usr/bin/env bash
set -euo pipefail

: "${SUITES:?SUITES must contain the resolved suite names}"

case "${1:-}" in
  start)
    integ/scripts/background.sh start json-python '
      ./python/.venv/bin/python integ/runtime/run.py $SUITES'
    # MongoDB reseeds a shared database; sandbox mounts and the sandbox
    # default replace fixed paths in the same Docker container. Defer those
    # suites until Python exits.
    integ/scripts/background.sh start json-typescript '
      suites=()
      for suite in $SUITES; do
        case "$suite" in
          backend/mongodb|sandbox/mounts|sandbox/default_route) ;;
          *) suites+=("$suite") ;;
        esac
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
    for suite in $SUITES; do
      case "$suite" in
        backend/mongodb|sandbox/mounts|sandbox/default_route)
          (cd integ && pnpm exec tsx runtime/run.ts "$suite") || status=1
          ;;
      esac
    done
    exit "$status"
    ;;
  *)
    echo 'usage: parallel.sh start | wait' >&2
    exit 2
    ;;
esac
