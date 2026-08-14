#!/usr/bin/env bash
# `clis: {cli: <ref>}` battery: a workspace installs a program tree that
# lives in a file on disk, with no host program calling register_cli.
# Python loads a .py spec, TypeScript loads .mjs, .ts and .js, and all
# four must answer the same line, because the point of the ref form is
# that a deployment ships one CLI and both hosts run it.
#
# Every case goes through the real door: `mirage workspace create` reads
# the YAML, rebases the relative ref against the file's directory, sends
# the checked config to the daemon, and the daemon imports it. The ref is
# spelled relative on purpose; an absolute one would pass even with the
# rebase removed.
#
# Usage: cli_ref.sh "<py-cli>" "<ts-cli>"
set -uo pipefail

PY_CLI="${1:?python mirage cli command}"
TS_CLI="${2:?typescript mirage cli command}"
HERE="$(cd "$(dirname "$0")" && pwd)"
fail=0

# The generated YAML sits under integ/ so a relative ref reaches the
# fixtures and the JS fixtures resolve @struktoai/mirage-core through
# integ/node_modules, the way a real deployment's CLI resolves it from
# its own project.
RUN="$(mktemp -d "$HERE/.cli-ref.XXXXXX")"
trap 'rm -rf "$RUN"' EXIT

RESULTS="$RUN/results.txt"
: > "$RESULTS"

sout() { jq -r '.stdout // .result.stdout // empty'; }

# A daemon left behind by an earlier run holds the default port under a
# different MIRAGE_HOME, so `daemon stop` cannot see it and every create
# in this run fails for a reason that has nothing to do with the ref.
freeport() {
  lsof -ti:8765 2>/dev/null | xargs kill -9 2>/dev/null
  sleep 1
}

emit() { echo "$1" | tee -a "$RESULTS"; }

write_yaml() {
  local ref="$1" path="$2"
  cat > "$path" <<YML
mode: WRITE
mounts:
  /data:
    resource: ram
clis:
  tally:
    cli: $ref
    config:
      unit: kg
YML
}

# One reference, end to end: create the workspace, run the CLI, read its
# manual. `man` is here because a CLI's help is rendered from the spec,
# so a tree that imported but arrived malformed still answers `sum`.
probe() {
  local cli="$1" lang="$2" tag="$3" ref="$4"
  local yaml="$RUN/$lang-$tag.yaml" id="cr$lang$tag"
  write_yaml "$ref" "$yaml"
  $cli workspace delete "$id" >/dev/null 2>&1 </dev/null || true
  if ! $cli workspace create "$yaml" --id "$id" >/dev/null 2>&1 </dev/null; then
    emit "$lang.$tag.sum=WORKSPACE_CREATE_FAILED"
    return
  fi
  emit "$lang.$tag.sum=$($cli execute -w "$id" -c 'tally sum 2 3 4' </dev/null | sout | tr -d '\n')"
  emit "$lang.$tag.man=$($cli execute -w "$id" -c 'man tally | grep -c sum' </dev/null | sout | tr -d '\n')"
  emit "$lang.$tag.type=$($cli execute -w "$id" -c 'type -t tally' </dev/null | sout | tr -d '\n')"
  $cli workspace delete "$id" >/dev/null 2>&1 </dev/null || true
}

# A ref that names an export the file does not have must be refused at
# create time, not discovered when an agent first types the head word.
probe_missing_export() {
  local cli="$1" lang="$2" ref="$3"
  local yaml="$RUN/$lang-missing.yaml" id="cr${lang}missing"
  write_yaml "$ref" "$yaml"
  $cli workspace delete "$id" >/dev/null 2>&1 </dev/null || true
  local out
  out="$($cli workspace create "$yaml" --id "$id" 2>&1 </dev/null)"
  if [ $? -eq 0 ]; then
    emit "$lang.missing_export=CREATED"
    $cli workspace delete "$id" >/dev/null 2>&1 </dev/null || true
  elif echo "$out" | grep -q "not found in"; then
    emit "$lang.missing_export=refused_naming_the_export"
  else
    emit "$lang.missing_export=refused_without_naming_it"
  fi
}

echo "== python =="
export MIRAGE_HOME="/tmp/cli-ref-home-py"
rm -rf "$MIRAGE_HOME"
$PY_CLI daemon stop >/dev/null 2>&1 </dev/null || true
freeport
probe "$PY_CLI" py py "../fixtures/cli/tally_cli.py:TALLY"
probe_missing_export "$PY_CLI" py "../fixtures/cli/tally_cli.py:NOPE"
$PY_CLI daemon stop >/dev/null 2>&1 </dev/null || true

echo "== typescript =="
export MIRAGE_HOME="/tmp/cli-ref-home-ts"
rm -rf "$MIRAGE_HOME"
$TS_CLI daemon stop >/dev/null 2>&1 </dev/null || true
freeport
probe "$TS_CLI" ts mjs "../fixtures/cli/tally_cli.mjs:TALLY"
probe "$TS_CLI" ts ts "../fixtures/cli/tally_cli.ts:TALLY"
probe "$TS_CLI" ts js "../fixtures/cli/tally_cli.js:TALLY"
probe_missing_export "$TS_CLI" ts "../fixtures/cli/tally_cli.mjs:NOPE"
$TS_CLI daemon stop >/dev/null 2>&1 </dev/null || true

echo
echo "== expected =="
expect() {
  local key="$1" want="$2" got
  got="$(grep -m1 "^$key=" "$RESULTS" | cut -d= -f2-)"
  if [ "$got" == "$want" ]; then
    echo "ok   $key=$got"
  else
    echo "FAIL $key: want '$want', got '$got'"
    fail=1
  fi
}

for case in py.py ts.mjs ts.ts ts.js; do
  expect "$case.sum" "total 9 kg"
  expect "$case.man" "1"
  expect "$case.type" "cli"
done
expect "py.missing_export" "refused_naming_the_export"
expect "ts.missing_export" "refused_naming_the_export"

echo
if [ "$fail" -eq 0 ]; then
  echo "cli_ref: PASS"
else
  echo "cli_ref: FAIL"
fi
exit "$fail"
