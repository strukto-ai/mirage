#!/usr/bin/env bash
# `runtimes: [{name: <ref>}]` battery: a workspace routes lines to runtimes
# that live in a file on disk, with no host program calling
# register_runtime, one per tier the workspace can route to. EchoBox takes
# whole lines (the door every sandbox provider uses) and ShoutPython is an
# interpreter (the door python3 uses), so both tiers are proven pluggable
# from yaml. Python loads a .py class, TypeScript loads .mjs and .ts, and
# every flavour must answer the same lines, because the point of the ref
# form is that a deployment ships one runtime and both hosts run it.
#
# Every case goes through the real door: `mirage workspace create` reads
# the YAML, rebases the relative ref against the file's directory, and the
# daemon imports it. The refusals are pinned too: a ref to a missing file
# and a ref to something that is not a Runtime both fail the create with
# one wording on both hosts.
#
# Usage: runtime_ref.sh "<py-cli>" "<ts-cli>"
set -uo pipefail

PY_CLI="${1:?python mirage cli command}"
TS_CLI="${2:?typescript mirage cli command}"
HERE="$(cd "$(dirname "$0")" && pwd)"
fail=0

# The generated YAML sits under integ/ so a relative ref reaches the
# fixtures and the JS fixtures resolve @struktoai/mirage-node through
# integ/node_modules, the way a real deployment's CLI resolves it from
# its own project.
RUN="$(mktemp -d "$HERE/.runtime-ref.XXXXXX")"
trap 'rm -rf "$RUN"' EXIT

RESULTS="$RUN/results.txt"
: > "$RESULTS"

sout() { jq -r '.stdout // .result.stdout // empty'; }

freeport() {
  lsof -ti:8765 2>/dev/null | xargs kill -9 2>/dev/null
  sleep 1
}

emit() { echo "$1" | tee -a "$RESULTS"; }

# Both refs spell the file relative on purpose; an absolute one would pass
# even with the rebase removed. The two entry spellings are both used: a
# mapping (`name:` plus the uniform options) and the bare string a builtin
# name is written as, so both rebase paths are exercised.
write_yaml() {
  local ref_file="$1" path="$2" box_attr="$3"
  cat > "$path" <<YML
mode: EXEC
mounts:
  /ram:
    resource: ram
runtimes:
  - name: $ref_file:ShoutPython
    captures: [python3]
  - $ref_file:$box_attr
  - vfs
YML
}

run_line() {
  local cli="$1" id="$2" line="$3"
  $cli execute -w "$id" -c "$line" </dev/null | sout | tr -d '\n'
}

# The routed half: create from the refs, then one line per tier plus one
# the workspace keeps for itself.
probe_routed() {
  local cli="$1" lang="$2" tag="$3" ref_file="$4"
  local yaml="$RUN/$lang-$tag.yaml" id="rr${lang}${tag}rt"
  write_yaml "$ref_file" "$yaml" EchoBox
  $cli workspace delete "$id" >/dev/null 2>&1 </dev/null || true
  if ! $cli workspace create "$yaml" --id "$id" >/dev/null 2>&1 </dev/null; then
    emit "$lang.$tag.line=WORKSPACE_CREATE_FAILED"
    return
  fi
  emit "$lang.$tag.line=$(run_line "$cli" "$id" 'nvidia-smi -L')"
  emit "$lang.$tag.vfs=$(run_line "$cli" "$id" 'echo routed')"
  emit "$lang.$tag.interp=$(run_line "$cli" "$id" "python3 -c 'hello from yaml'")"
  $cli workspace delete "$id" >/dev/null 2>&1 </dev/null || true
}

# The refused half: a ref that does not load, and one that loads
# something other than a Runtime. Neither may create a workspace.
probe_refused() {
  local cli="$1" lang="$2" tag="$3" ref_file="$4"
  local yaml="$RUN/$lang-$tag-missing.yaml" id="rr${lang}${tag}rm" out
  write_yaml "${ref_file%.*}_missing.${ref_file##*.}" "$yaml" EchoBox
  out="$($cli workspace create "$yaml" --id "$id" 2>&1 </dev/null)"
  if [ $? -eq 0 ]; then
    emit "$lang.$tag.missing=CREATED_FROM_A_MISSING_FILE"
    $cli workspace delete "$id" >/dev/null 2>&1 </dev/null || true
  elif echo "$out" | grep -q "cannot load script"; then
    emit "$lang.$tag.missing=refused_naming_the_file"
  else
    emit "$lang.$tag.missing=refused_without_naming_it"
  fi
  yaml="$RUN/$lang-$tag-notrt.yaml" id="rr${lang}${tag}rn"
  write_yaml "$ref_file" "$yaml" NOT_A_RUNTIME
  out="$($cli workspace create "$yaml" --id "$id" 2>&1 </dev/null)"
  if [ $? -eq 0 ]; then
    emit "$lang.$tag.notrt=CREATED_FROM_A_NON_RUNTIME"
    $cli workspace delete "$id" >/dev/null 2>&1 </dev/null || true
  elif echo "$out" | grep -q "is not a Runtime subclass"; then
    emit "$lang.$tag.notrt=refused_as_not_a_runtime"
  else
    emit "$lang.$tag.notrt=refused_without_saying_why"
  fi
}

probe() {
  probe_routed "$@"
  probe_refused "$@"
}

echo "== python =="
export MIRAGE_HOME="/tmp/runtime-ref-home-py"
rm -rf "$MIRAGE_HOME"
$PY_CLI daemon stop >/dev/null 2>&1 </dev/null || true
freeport
probe "$PY_CLI" py py "../fixtures/runtime/box_runtimes.py"
$PY_CLI daemon stop >/dev/null 2>&1 </dev/null || true

echo "== typescript =="
export MIRAGE_HOME="/tmp/runtime-ref-home-ts"
rm -rf "$MIRAGE_HOME"
$TS_CLI daemon stop >/dev/null 2>&1 </dev/null || true
freeport
probe "$TS_CLI" ts mjs "../fixtures/runtime/box_runtimes.mjs"
probe "$TS_CLI" ts ts "../fixtures/runtime/box_runtimes.ts"
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

for case in py.py ts.mjs ts.ts; do
  expect "$case.line" "box:nvidia-smi -L"
  expect "$case.vfs" "routed"
  expect "$case.interp" "HELLO FROM YAML"
  expect "$case.missing" "refused_naming_the_file"
  expect "$case.notrt" "refused_as_not_a_runtime"
done

echo
if [ "$fail" -eq 0 ]; then
  echo "runtime_ref: PASS"
else
  echo "runtime_ref: FAIL"
fi
exit "$fail"
