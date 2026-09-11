#!/usr/bin/env bash
# `mounts: {resource: <ref>}` battery: a workspace mounts a backend that
# lives in a file on disk, with no host program calling register_resource,
# and a snapshot of it comes back through the same reference. Python loads
# a .py class, TypeScript loads .mjs and .ts, and every flavour must answer
# the same lines, because the point of the ref form is that a deployment
# ships one backend and both hosts run it.
#
# Every case goes through the real door: `mirage workspace create` reads
# the YAML, rebases the relative ref against the file's directory, and the
# daemon imports it; `workspace snapshot` records the reference beside the
# class path; `workspace load` rebuilds the mount through it. The two
# halves of the versioning design are both here. The wiki owns its pages
# (get_state/load_state), so the snapshot restores them with no override
# and the live workspace keeps its later change. The feed keeps the
# default state, so a load that does not hand it back is refused, naming
# the mount, and a load given the config again gets the live resource.
#
# Usage: resource_ref.sh "<py-cli>" "<ts-cli>"
set -uo pipefail

PY_CLI="${1:?python mirage cli command}"
TS_CLI="${2:?typescript mirage cli command}"
HERE="$(cd "$(dirname "$0")" && pwd)"
fail=0

# The generated YAML sits under integ/ so a relative ref reaches the
# fixtures and the JS fixtures resolve @struktoai/mirage-core through
# integ/node_modules, the way a real deployment's CLI resolves it from
# its own project.
RUN="$(mktemp -d "$HERE/.resource-ref.XXXXXX")"
trap 'rm -rf "$RUN"' EXIT

RESULTS="$RUN/results.txt"
: > "$RESULTS"

sout() { jq -r '.stdout // .result.stdout // empty'; }

freeport() {
  lsof -ti:8765 2>/dev/null | xargs kill -9 2>/dev/null
  sleep 1
}

emit() { echo "$1" | tee -a "$RESULTS"; }

# One yaml per case: the owned mount alone, or the owned and the observed
# mount together. Both spell the ref relative on purpose; an absolute one
# would pass even with the rebase removed.
write_yaml() {
  local ref_file="$1" path="$2" with_feed="$3"
  cat > "$path" <<YML
mode: WRITE
mounts:
  /wiki:
    resource: $ref_file:WikiResource
YML
  if [ "$with_feed" == "1" ]; then
    cat >> "$path" <<YML
  /feed:
    resource: $ref_file:FeedResource
YML
  fi
}

run_line() {
  local cli="$1" id="$2" line="$3"
  $cli execute -w "$id" -c "$line" </dev/null | sout | tr -d '\n'
}

# The owned half: create from the ref, write a page, snapshot, change the
# page, load with no config at all. The restored workspace serves the page
# as it was; the live one keeps the change.
probe_owned() {
  local cli="$1" lang="$2" tag="$3" ref_file="$4"
  local yaml="$RUN/$lang-$tag-owned.yaml" id="rr${lang}${tag}o" rid="rr${lang}${tag}or"
  local tar="$MIRAGE_HOME/snapshots/$lang-$tag-owned.tar"
  mkdir -p "$MIRAGE_HOME/snapshots"
  write_yaml "$ref_file" "$yaml" 0
  $cli workspace delete "$id" >/dev/null 2>&1 </dev/null || true
  $cli workspace delete "$rid" >/dev/null 2>&1 </dev/null || true
  if ! $cli workspace create "$yaml" --id "$id" >/dev/null 2>&1 </dev/null; then
    emit "$lang.$tag.owned.seed=WORKSPACE_CREATE_FAILED"
    return
  fi
  emit "$lang.$tag.owned.seed=$(run_line "$cli" "$id" 'cat /wiki/notes.md')"
  $cli execute -w "$id" -c "echo '# Runbook' > /wiki/runbook.md" >/dev/null 2>&1 </dev/null
  if ! $cli workspace snapshot "$id" "$tar" >/dev/null 2>&1 </dev/null; then
    emit "$lang.$tag.owned.restored=SNAPSHOT_FAILED"
    return
  fi
  $cli execute -w "$id" -c "echo '# Runbook, revised' > /wiki/runbook.md" >/dev/null 2>&1 </dev/null
  if ! $cli workspace load "$tar" --id "$rid" >/dev/null 2>&1 </dev/null; then
    emit "$lang.$tag.owned.restored=LOAD_FAILED"
    return
  fi
  emit "$lang.$tag.owned.live=$(run_line "$cli" "$id" 'cat /wiki/runbook.md')"
  emit "$lang.$tag.owned.restored=$(run_line "$cli" "$rid" 'cat /wiki/runbook.md')"
  emit "$lang.$tag.owned.listing=$(run_line "$cli" "$rid" 'ls /wiki')"
  $cli workspace delete "$id" >/dev/null 2>&1 </dev/null || true
  $cli workspace delete "$rid" >/dev/null 2>&1 </dev/null || true
}

# The observed half: the same snapshot with a feed mount that keeps the
# default state. A load with no config is refused and names the mount; a
# load given the config again hands the live feed back and restores the
# wiki through its reference at the same time.
probe_observed() {
  local cli="$1" lang="$2" tag="$3" ref_file="$4"
  local yaml="$RUN/$lang-$tag-both.yaml" id="rr${lang}${tag}b" rid="rr${lang}${tag}br"
  local tar="$MIRAGE_HOME/snapshots/$lang-$tag-both.tar"
  mkdir -p "$MIRAGE_HOME/snapshots"
  write_yaml "$ref_file" "$yaml" 1
  $cli workspace delete "$id" >/dev/null 2>&1 </dev/null || true
  $cli workspace delete "$rid" >/dev/null 2>&1 </dev/null || true
  if ! $cli workspace create "$yaml" --id "$id" >/dev/null 2>&1 </dev/null; then
    emit "$lang.$tag.both.refusal=WORKSPACE_CREATE_FAILED"
    return
  fi
  $cli execute -w "$id" -c "cat /feed/status.md" >/dev/null 2>&1 </dev/null
  $cli execute -w "$id" -c "echo '# Runbook' > /wiki/runbook.md" >/dev/null 2>&1 </dev/null
  if ! $cli workspace snapshot "$id" "$tar" >/dev/null 2>&1 </dev/null; then
    emit "$lang.$tag.both.refusal=SNAPSHOT_FAILED"
    return
  fi
  local out
  out="$($cli workspace load "$tar" --id "$rid" 2>&1 </dev/null)"
  if [ $? -eq 0 ]; then
    emit "$lang.$tag.both.refusal=LOADED_WITHOUT_THE_FEED"
    $cli workspace delete "$rid" >/dev/null 2>&1 </dev/null || true
  elif echo "$out" | grep -q "must include overrides" && echo "$out" | grep -q "/feed"; then
    emit "$lang.$tag.both.refusal=refused_naming_the_mount"
  else
    emit "$lang.$tag.both.refusal=refused_without_naming_it"
  fi
  if ! $cli workspace load "$tar" "$yaml" --id "$rid" >/dev/null 2>&1 </dev/null; then
    emit "$lang.$tag.both.restored=LOAD_WITH_CONFIG_FAILED"
    $cli workspace delete "$id" >/dev/null 2>&1 </dev/null || true
    return
  fi
  emit "$lang.$tag.both.restored=$(run_line "$cli" "$rid" 'cat /wiki/runbook.md')"
  emit "$lang.$tag.both.feed=$(run_line "$cli" "$rid" 'cat /feed/status.md')"
  $cli workspace delete "$id" >/dev/null 2>&1 </dev/null || true
  $cli workspace delete "$rid" >/dev/null 2>&1 </dev/null || true
}

probe() {
  probe_owned "$@"
  probe_observed "$@"
}

echo "== python =="
export MIRAGE_HOME="/tmp/resource-ref-home-py"
rm -rf "$MIRAGE_HOME"
$PY_CLI daemon stop >/dev/null 2>&1 </dev/null || true
freeport
probe "$PY_CLI" py py "../fixtures/resource/wiki_backend.py"
$PY_CLI daemon stop >/dev/null 2>&1 </dev/null || true

echo "== typescript =="
export MIRAGE_HOME="/tmp/resource-ref-home-ts"
rm -rf "$MIRAGE_HOME"
$TS_CLI daemon stop >/dev/null 2>&1 </dev/null || true
freeport
probe "$TS_CLI" ts mjs "../fixtures/resource/wiki_backend.mjs"
probe "$TS_CLI" ts ts "../fixtures/resource/wiki_backend.ts"
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
  expect "$case.owned.seed" "agents just speak bash"
  expect "$case.owned.live" "# Runbook, revised"
  expect "$case.owned.restored" "# Runbook"
  expect "$case.owned.listing" "notes.mdrunbook.md"
  expect "$case.both.refusal" "refused_naming_the_mount"
  expect "$case.both.restored" "# Runbook"
  expect "$case.both.feed" "All systems go."
done

echo
if [ "$fail" -eq 0 ]; then
  echo "resource_ref: PASS"
else
  echo "resource_ref: FAIL"
fi
exit "$fail"
