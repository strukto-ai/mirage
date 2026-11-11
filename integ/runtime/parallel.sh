#!/usr/bin/env bash
set -euo pipefail

: "${SUITES:?SUITES must contain the resolved suite names}"

case "${1:-}" in
  start)
    # Sandbox mounts serve fixed paths over sshfs in the one Docker
    # container, which the CLI runner's step uses meanwhile, and a machine
    # refuses a second server for a path. Python's run of that suite waits
    # for the CLI step to finish.
    integ/scripts/background.sh start json-python '
      suites=()
      for suite in $SUITES; do
        case "$suite" in
          sandbox/mounts) ;;
          *) suites+=("$suite") ;;
        esac
      done
      if [ "${#suites[@]}" -gt 0 ]; then
        ./python/.venv/bin/python integ/runtime/run.py "${suites[@]}"
      fi'
    # MongoDB reseeds a shared database, and sandbox mounts go one host at
    # a time. Defer those suites until Python exits.
    integ/scripts/background.sh start json-typescript '
      suites=()
      for suite in $SUITES; do
        case "$suite" in
          backend/mongodb|sandbox/mounts) ;;
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
      if [ "$suite" = sandbox/mounts ]; then
        ./python/.venv/bin/python integ/runtime/run.py "$suite" || status=1
      fi
    done
    for suite in $SUITES; do
      case "$suite" in
        backend/mongodb|sandbox/mounts)
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
