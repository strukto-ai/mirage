#!/usr/bin/env bash
# Drive the runtime JSON suites through the CLI and daemon of both
# languages: the same cases integ/runtime/run.{py,ts} execute in
# process, here built from a generated workspace yaml (`mirage
# workspace create`) and executed with `mirage execute`. This is the
# yaml -> daemon -> CLI construction path: entry captures, config
# blocks, per-entry scripts (policy), the global route, per-mount
# command_limits, and the per-line --runtime argument.
#
# Cases whose steps need the SDK surface (add_runtime, rename, s3_put,
# read_op, facade — the last calls ws.fs directly) or a runner-local
# test runtime (echobox, named as a string or a mapping, or registered
# through world.register_runtimes) or runner-local code policies
# (world.policies) or non-ram mounts are skipped as sdk-only. Expect semantics: exit and
# stdout are exact, stderr is a containment check (the CLI owns its
# stderr framing), and the SDK-side expectations (ops_contain,
# ops_absent, value) are not checked because the op ledger has no CLI
# door.
#
# A yaml file is any JSON document here: YAML is a superset of JSON,
# so the driver emits the case world as JSON with jq and both loaders
# parse it; inline script sources become .py files next to the yaml.
#
# Usage: cli.sh "<py-cli>" "<ts-cli>"
set -uo pipefail

PY_CLI="${1:?python mirage cli command}"
TS_CLI="${2:?typescript mirage cli command}"
SUITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STRICT="${INTEG_RUNTIME_STRICT:-0}"

pass=0
fail=0
skipped=0
failures=()

requirement_met() {
  local req="$1"
  local var
  case "$req" in
    env:*)
      var="${req#env:}"
      [ -n "${!var:-}" ] ;;
    s3) return 1 ;;
    *) echo "unknown requirement: $req" >&2; return 1 ;;
  esac
}

# Whether this case can run over the CLI at all. Worlds carrying code
# policies (runner-local Policy classes) cannot cross the yaml/daemon
# boundary, and read_op steps need the SDK op door.
cli_expressible() {
  local case_json="$1"
  jq -e '
    ((.world.mounts // {"/ram": {"resource": "ram"}})
      | to_entries | all(.value.resource == "ram"))
    and (((.world.policies // []) | length) == 0)
    and (((.world.runtimes // []) | map(select((type == "object" and .name == "echobox") or . == "echobox")) | length) == 0)
    and (((.world.register_runtimes // {}) | length) == 0)
    and (((.steps // []) | map(select(has("add_runtime") or has("rename") or has("s3_put") or has("read_op") or has("facade"))) | length) == 0)
  ' >/dev/null <<<"$case_json"
}

# Emit the workspace yaml (as JSON) for a case world, extracting any
# inline script sources into .py files under $2.
write_world_yaml() {
  local world_json="$1" work="$2"
  local n i src policy
  n=$(jq '(.runtimes // []) | length' <<<"$world_json")
  for i in $(seq 0 $((n - 1))); do
    src=$(jq -r ".runtimes[$i] | if type == \"object\" then .script // empty else empty end" <<<"$world_json")
    if [ -n "$src" ]; then
      printf '%s' "$src" > "$work/script_$i.py"
      world_json=$(jq --arg p "$work/script_$i.py" ".runtimes[$i].script = \$p" <<<"$world_json")
    fi
  done
  policy=$(jq -r '.route_policy // empty' <<<"$world_json")
  if [ -n "$policy" ]; then
    printf '%s' "$policy" > "$work/policy.py"
    world_json=$(jq --arg p "$work/policy.py" '.route_policy = $p' <<<"$world_json")
  fi
  # A script CLI's program becomes a file the yaml `clis:` block points
  # at, the same build-context shape a deployment writes by hand; the
  # extension carries the language the runner passed inline.
  local cli ext
  while IFS= read -r cli; do
    [ -n "$cli" ] || continue
    src=$(jq -r --arg n "$cli" '.clis[$n].script' <<<"$world_json")
    ext=$([ "$(jq -r --arg n "$cli" '.clis[$n].language // "python"' <<<"$world_json")" = "js" ] && echo js || echo py)
    printf '%s' "$src" > "$work/cli_$cli.$ext"
    world_json=$(jq --arg n "$cli" --arg p "$work/cli_$cli.$ext" \
      '.clis[$n] = ((.clis[$n] | del(.script, .language)) + {script: $p})' \
      <<<"$world_json")
  done < <(jq -r '(.clis // {}) | keys[]' <<<"$world_json")
  jq '{mode: "EXEC",
       mounts: ((.mounts // {"/ram": {"resource": "ram"}})
         | map_values({resource: .resource}
             + (if .limits then {command_limits: .limits} else {} end)))}
      + (if .runtimes then {runtimes: .runtimes} else {} end)
      + (if .route_policy then {route_policy: .route_policy} else {} end)
      + (if .clis then {clis: .clis} else {} end)' \
    <<<"$world_json" > "$work/ws.yaml"
}

run_case() {
  local cli="$1" host="$2" suite="$3" case_json="$4" work="$5"
  local case_id wsid world_json
  case_id="$suite/$(jq -r '.id' <<<"$case_json")"
  wsid="rt-$(jq -r '.id' <<<"$case_json" | tr '_' '-')"
  world_json=$(jq -c '.world // {}' <<<"$case_json")
  write_world_yaml "$world_json" "$work"

  if jq -e 'has("build_error")' >/dev/null <<<"$case_json"; then
    local want
    want=$(jq -r '.build_error.contains' <<<"$case_json")
    if $cli workspace create "$work/ws.yaml" --id "$wsid" \
        >"$work/create.out" 2>&1 </dev/null; then
      failures+=("$case_id: expected workspace create to fail")
      $cli workspace delete "$wsid" >/dev/null 2>&1 </dev/null || true
      return 1
    fi
    if ! grep -qF "$want" "$work/create.out"; then
      failures+=("$case_id: create error missing '$want': $(head -c 300 "$work/create.out")")
      return 1
    fi
    return 0
  fi

  if ! $cli workspace create "$work/ws.yaml" --id "$wsid" \
      >"$work/create.out" 2>&1 </dev/null; then
    failures+=("$case_id: workspace create failed: $(head -c 300 "$work/create.out")")
    return 1
  fi

  # Seed declared mount files through the shell (cat reads the piped
  # stdin, the redirect writes the mount). A nested seed name needs its
  # parent first: the redirect refuses a missing directory, and it
  # refuses silently here, which reads as a file that was never
  # declared (run.py and run.ts mkdir the parent the same way).
  local prefix name ok=0
  while IFS=$'\t' read -r prefix name; do
    [ -n "$prefix" ] || continue
    case "$name" in
      */*)
        $cli execute -w "$wsid" -c "mkdir -p $prefix/${name%/*}" \
          >/dev/null 2>&1 </dev/null
        ;;
    esac
    jq -j --arg p "$prefix" --arg n "$name" \
      '.world.mounts[$p].files[$n]' <<<"$case_json" \
      | $cli execute -w "$wsid" -c "cat > $prefix/$name" >/dev/null 2>&1
  done < <(jq -r '(.world.mounts // {}) | to_entries[]
                  | .key as $p | (.value.files // {}) | keys[]
                  | [$p, .] | @tsv' <<<"$case_json")

  local steps step cmd runtime expect got_exit
  steps=$(jq -c '.steps[]' <<<"$case_json")
  local index=0
  while IFS= read -r step; do
    cmd=$(jq -r '.command' <<<"$step")
    runtime=$(jq -r '.runtime // empty' <<<"$step")
    expect=$(jq -c '.expect // {}' <<<"$step")
    local args=(execute -w "$wsid" -c "$cmd")
    [ -n "$runtime" ] && args+=(--runtime "$runtime")
    if jq -e 'has("stdin")' >/dev/null <<<"$step"; then
      jq -j '.stdin' <<<"$step" > "$work/stdin.bin"
    else
      : > "$work/stdin.bin"
    fi
    $cli "${args[@]}" < "$work/stdin.bin" \
      > "$work/got.out" 2> "$work/got.err"
    got_exit=$?
    # Both CLIs emit a JSON envelope on a non-tty stdout; unwrap the
    # command's own streams from it (raw output stays the fallback
    # for CLI-level errors).
    if jq -e '.kind == "io"' "$work/got.out" >/dev/null 2>&1; then
      jq -j '.stdout // ""' "$work/got.out" > "$work/got.stdout"
      jq -j '.stderr // ""' "$work/got.out" > "$work/got.stderr"
    else
      cp "$work/got.out" "$work/got.stdout"
      cp "$work/got.err" "$work/got.stderr"
    fi

    if jq -e 'has("throws_contains")' >/dev/null <<<"$expect"; then
      local want
      want=$(jq -r '.throws_contains' <<<"$expect")
      if [ "$got_exit" -eq 0 ] || ! grep -qF "$want" "$work/got.out" "$work/got.err"; then
        failures+=("$case_id step[$index]: expected an error containing '$want'")
        ok=1
      fi
      index=$((index + 1))
      continue
    fi
    if jq -e 'has("exit")' >/dev/null <<<"$expect"; then
      local want_exit
      want_exit=$(jq -r '.exit' <<<"$expect")
      if [ "$got_exit" -ne "$want_exit" ]; then
        failures+=("$case_id step[$index]: exit $got_exit, expected $want_exit: $(head -c 200 "$work/got.stderr")")
        ok=1
      fi
    fi
    if jq -e 'has("stdout")' >/dev/null <<<"$expect"; then
      jq -j '.stdout' <<<"$expect" > "$work/want.out"
      if ! cmp -s "$work/want.out" "$work/got.stdout"; then
        failures+=("$case_id step[$index]: stdout '$(cat "$work/got.stdout")', expected '$(cat "$work/want.out")'")
        ok=1
      fi
    fi
    if jq -e 'has("stdout_contains")' >/dev/null <<<"$expect"; then
      local want_frag
      want_frag=$(jq -r '.stdout_contains' <<<"$expect")
      if ! grep -qF "$want_frag" "$work/got.stdout"; then
        failures+=("$case_id step[$index]: stdout missing '$want_frag'")
        ok=1
      fi
    fi
    # The CLI owns its stderr framing, so exact stderr expectations
    # degrade to containment here.
    local want_err
    for key in stderr stderr_contains; do
      if jq -e --arg k "$key" 'has($k)' >/dev/null <<<"$expect"; then
        want_err=$(jq -r --arg k "$key" '.[$k]' <<<"$expect")
        if [ -n "$want_err" ] && ! grep -qF "$want_err" "$work/got.stderr"; then
          failures+=("$case_id step[$index]: stderr missing '$want_err': $(head -c 200 "$work/got.stderr")")
          ok=1
        fi
      fi
    done
    index=$((index + 1))
  done <<<"$steps"

  $cli workspace delete "$wsid" >/dev/null 2>&1 </dev/null || true
  return $ok
}

run_host() {
  local cli="$1" host="$2" port="$3"
  local home work
  home="$(mktemp -d "/tmp/rt-cli-$host-home.XXXXXX")"
  work="$(mktemp -d "/tmp/rt-cli-$host-work.XXXXXX")"
  export MIRAGE_HOME="$home"
  unset MIRAGE_DAEMON_PORT MIRAGE_DAEMON_URL MIRAGE_ALLOWED_HOSTS \
    MIRAGE_AUTH_MODE 2>/dev/null || true
  $cli config set port "$port" >/dev/null </dev/null
  $cli config set url "http://127.0.0.1:$port" >/dev/null </dev/null

  local file suite suite_json requires unmet
  for file in "$SUITE_DIR"/*.json; do
    suite_json=$(cat "$file")
    suite=$(jq -r '.suite' <<<"$suite_json")
    requires=$(jq -r --arg h "$host" \
      '(.requires // []) | if type == "array" then . else (.[$h] // []) end | .[]' \
      <<<"$suite_json")
    unmet=""
    for req in $requires; do
      requirement_met "$req" || unmet="$unmet $req"
    done
    if [ -n "$unmet" ]; then
      if [ "$STRICT" == "1" ] && \
          [ "$(jq -r '.optional // false' <<<"$suite_json")" != "true" ]; then
        failures+=("$host/$suite: unmet requirements$unmet (INTEG_RUNTIME_STRICT=1)")
        fail=$((fail + 1))
      else
        echo "skip $host/$suite (unmet:$unmet)"
        skipped=$((skipped + 1))
      fi
      continue
    fi
    local case_json
    while IFS= read -r case_json; do
      if ! jq -e --arg h "$host" \
          '(.hosts // ["python", "typescript"]) | index($h)' \
          >/dev/null <<<"$case_json"; then
        continue
      fi
      if ! cli_expressible "$case_json"; then
        echo "skip $host/$suite/$(jq -r '.id' <<<"$case_json") (sdk-only)"
        skipped=$((skipped + 1))
        continue
      fi
      if run_case "$cli" "$host" "$suite" "$case_json" "$work"; then
        echo "ok $host/$suite/$(jq -r '.id' <<<"$case_json")"
        pass=$((pass + 1))
      else
        echo "FAIL $host/$suite/$(jq -r '.id' <<<"$case_json")"
        fail=$((fail + 1))
      fi
    done < <(jq -c '.cases[]' <<<"$suite_json")
  done

  $cli daemon stop >/dev/null 2>&1 </dev/null || true
  sleep 1

  # Each host runs in its own subshell, so its tally has to leave through
  # the filesystem: a subshell's variables die with it.
  printf '%s %s %s\n' "$pass" "$fail" "$skipped" > "$RESULT_DIR/$host.tally"
  : > "$RESULT_DIR/$host.failures"
  for line in "${failures[@]:-}"; do
    [ -n "$line" ] && printf '%s\n' "$line" >> "$RESULT_DIR/$host.failures"
  done
}

# The two hosts are independent: separate daemon ports, a MIRAGE_HOME each,
# and only ram mounts reach the CLI (see cli_expressible), so they share no
# store. The docker suite is the one thing they do share, and its cases are
# stateless execs (echo, exit, wc, uname) rather than writes, so two
# `docker exec` sessions in the one container cannot collide. Running them
# together halves the longest step in the integ workflow.
RESULT_DIR="$(mktemp -d "/tmp/rt-cli-results.XXXXXX")"

(run_host "$PY_CLI" "python" 8791) > "$RESULT_DIR/python.log" 2>&1 &
py_pid=$!
(run_host "$TS_CLI" "typescript" 8792) > "$RESULT_DIR/typescript.log" 2>&1 &
ts_pid=$!
wait "$py_pid"
wait "$ts_pid"

# Printed per host rather than interleaved, which is what makes a failure
# readable: the two hosts would otherwise write over each other's lines.
for host in python typescript; do
  echo "=== $host ==="
  cat "$RESULT_DIR/$host.log"
done

pass=0
fail=0
skipped=0
failures=()
for host in python typescript; do
  if [ ! -s "$RESULT_DIR/$host.tally" ]; then
    failures+=("$host: no tally written (the host died before finishing)")
    fail=$((fail + 1))
    continue
  fi
  read -r host_pass host_fail host_skipped < "$RESULT_DIR/$host.tally"
  pass=$((pass + host_pass))
  fail=$((fail + host_fail))
  skipped=$((skipped + host_skipped))
  while IFS= read -r line; do
    [ -n "$line" ] && failures+=("$line")
  done < "$RESULT_DIR/$host.failures"
done

echo ""
echo "$pass passed, $fail failed, $skipped skipped"
for line in "${failures[@]:-}"; do
  [ -n "$line" ] && echo "  $line"
done
[ "$fail" -eq 0 ]
