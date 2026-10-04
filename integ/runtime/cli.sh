#!/usr/bin/env bash
# Drive the runtime JSON suites through the CLI and daemon of both
# languages: the same cases integ/runtime/run.{py,ts} execute in
# process, here built from a generated workspace yaml (`mirage
# workspace create`) and executed with `mirage shell`. This is the
# yaml -> daemon -> CLI construction path: entry captures, config
# blocks, per-entry scripts (policy), the global route, workspace,
# mount and profile command_limits, and the per-line --runtime argument.
#
# Cases whose steps need the SDK surface (add_runtime, rename, s3_put,
# read_op, facade — the last calls ws.vfs directly) or a runner-local
# test runtime (echobox, named as a string or a mapping, or registered
# through world.register_runtimes), generated file catalogs, runner-local
# code policies (world.policies), or non-ram mounts are skipped as sdk-only,
# as is a case that states why it must be in `sdk_only`. Expect semantics: exit and
# stdout are exact, stderr is a containment check (the CLI owns its
# stderr framing), and the SDK-side expectations (ops_contain,
# ops_absent, ops_count, value) are not checked because the op ledger has no CLI
# door.
#
# A yaml file is any JSON document here: YAML is a superset of JSON,
# so the driver emits the case world as JSON with jq and both loaders
# parse it; inline script sources become .py files next to the yaml.
#
# Usage: cli.sh "<py-cli>" "<ts-cli>" [suite ...]
set -uo pipefail

PY_CLI="${1:?python mirage cli command}"
TS_CLI="${2:?typescript mirage cli command}"
ONLY_SUITES=("${@:3}")
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

# The runtime table run.py and run.ts keep: the guest language of each
# runtime a case's `runtimes` may name (null for a sandbox, which runs whole
# lines), the line head a program runs under, per host what the runtime
# needs (absent: not on that host; e2b is python's only, see the README),
# the world entry it is built from, and the runtimes an unmet requirement
# skips even under INTEG_RUNTIME_STRICT.
RUNTIMES='{
  "language": {"monty": "python", "wasi": "python", "pyodide": "python", "quickjs": "js",
    "local": "python", "sandlock": "python", "docker": null, "ssh": null, "e2b": null,
    "smolvm": null, "apple_container": null},
  "head": {"python": "python3 -c", "js": "node -e"},
  "requires": {
    "python": {"monty": [], "wasi": ["env:MIRAGE_WASI_HOME"], "quickjs": ["env:MIRAGE_QUICKJS_HOME"],
      "local": [], "sandlock": ["env:MIRAGE_INTEG_SANDLOCK"],
      "docker": ["env:MIRAGE_INTEG_DOCKER_CONTAINER"], "ssh": ["env:MIRAGE_INTEG_SSH_HOST"],
      "e2b": ["env:MIRAGE_INTEG_E2B_SANDBOX"], "smolvm": ["env:MIRAGE_INTEG_SMOLVM_MACHINE"],
      "apple_container": ["env:MIRAGE_INTEG_APPLE_CONTAINER"]},
    "typescript": {"monty": [], "pyodide": [], "quickjs": [],
      "local": [], "sandlock": ["env:MIRAGE_INTEG_SANDLOCK"],
      "docker": ["env:MIRAGE_INTEG_DOCKER_CONTAINER"], "ssh": ["env:MIRAGE_INTEG_SSH_HOST"],
      "smolvm": ["env:MIRAGE_INTEG_SMOLVM_MACHINE"],
      "apple_container": ["env:MIRAGE_INTEG_APPLE_CONTAINER"]}
  },
  "entry": {
    "sandlock": {"captures": ["python3", "node", "@external"]},
    "docker": {"captures": ["*"], "config": {"container": "${MIRAGE_INTEG_DOCKER_CONTAINER}"}},
    "ssh": {"captures": ["*"], "config": {"host": "${MIRAGE_INTEG_SSH_HOST}", "port": 2222,
      "username": "${MIRAGE_INTEG_SSH_USERNAME}", "identity_file": "${MIRAGE_INTEG_SSH_KEY}"}},
    "e2b": {"captures": ["*"], "config": {"sandbox_id": "${MIRAGE_INTEG_E2B_SANDBOX}"}},
    "smolvm": {"captures": ["*"], "config": {"machine": "${MIRAGE_INTEG_SMOLVM_MACHINE}"}},
    "apple_container": {"captures": ["*"], "config": {"container": "${MIRAGE_INTEG_APPLE_CONTAINER}"}}
  },
  "optional": ["sandlock", "e2b", "smolvm", "apple_container"]
}'

# The case once per runtime it names on this host, one JSON per line (a case
# without `runtimes` is printed as it is), as run.py `_for_runtime` builds
# them: a step's `program`, `script` or `command` map picks the runtime's
# language (a step without it is left out), `expect_on` keyed by the
# runtime, then by `runtime@host`, then by `ram` and `runtime@ram` (every
# mount here is RAM: this is a case's ram variant), is merged over `expect`,
# and the world runs the runtime's table entry with the case's `entry` laid
# over it.
# INTEG_RUNTIMES (comma separated) keeps only the runtimes it names.
runtime_variants() {
  local case_json="$1" host="$2"
  jq -c --arg h "$host" --arg only "${INTEG_RUNTIMES:-}" --argjson t "$RUNTIMES" '
    if has("runtimes") | not then . else
      . as $c
      | $c.runtimes[]
      | select($t.requires[$h][.] != null)
      | . as $r
      | select($only == "" or (($only | split(",")) | index($r)) != null)
      | $t.language[$r] as $lang
      | ($t.entry[$r] // {}) as $base
      | ($c.entry // {}) as $over
      | [$c.steps[]
          | if $lang == null then .
            elif has("program") then
              select(.program[$lang] != null)
              | del(.program) + {command: ($t.head[$lang] + " " + (.program[$lang] | @sh)), guest: true}
            elif (.script | type) == "object" then
              select(.script[$lang] != null)
              | . + {command: $t.head[$lang], script: .script[$lang], guest: true}
            elif (.command | type) == "object" then
              select(.command[$lang] != null)
              | . + {command: .command[$lang], guest: true}
            else . end
          | .expect = ((.expect // {}) + ((.expect_on // {})[$r] // {})
              + ((.expect_on // {})[$r + "@" + $h] // {})
              + ((.expect_on // {}).ram // {})
              + ((.expect_on // {})[$r + "@ram"] // {}))
        ] as $steps
      | select($lang == null or any($steps[]; .guest))
      | (if $base == {} and $over == {} then $r
         else {name: $r} + $base + $over
           + (if ($base | has("config")) or ($over | has("config"))
              then {config: (($base.config // {}) + ($over.config // {}))} else {} end)
         end) as $entry
      | $c + {
          id: ($c.id + "@" + $r),
          world: (($c.world // {}) + {runtimes: [$entry, "workspace"]}),
          steps: ($steps | map(del(.guest))),
          requires: (($c.requires // []) + $t.requires[$h][$r]),
          optional: ($t.optional | index($r) != null)
        }
    end' <<<"$case_json"
}

# Whether this case can run over the CLI at all. Worlds carrying code
# policies (runner-local Policy classes) or a failing mount (a runner-local
# VFS) cannot cross the yaml/daemon boundary, and read_op steps need the
# SDK op door.
cli_expressible() {
  local case_json="$1"
  jq -e '
    (has("sdk_only") | not)
    and ((.world.mounts // {"/ram": {"vfs": "ram"}})
      | to_entries | all(.value.vfs == "ram"))
    and (((.world.mounts // {}) | to_entries) | all(.value.generated_files == null))
    and (((.world.mounts // {}) | to_entries) | all(.value.failing == null))
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
       mounts: ((.mounts // {"/ram": {"vfs": "ram"}})
         | map_values({vfs: .vfs}
             + (if .mode then {mode: .mode} else {} end)
             + (if .limits then {command_limits: .limits} else {} end)))}
      + (if .command_limits then {command_limits: .command_limits} else {} end)
      + (if .profiles then {profiles: .profiles} else {} end)
      + (if .profile then {profile: .profile} else {} end)
      + (if .runtimes then {runtimes: .runtimes} else {} end)
      + (if .route_policy then {route_policy: .route_policy} else {} end)
      + (if .clis then {clis: .clis} else {} end)' \
    <<<"$world_json" > "$work/ws.yaml"
}

run_case() {
  local cli="$1" host="$2" suite="$3" case_json="$4" work="$5"
  local case_id wsid world_json session_id
  case_id="$suite/$(jq -r '.id' <<<"$case_json")"
  # The suite is part of the id: two suites may share a case id. A
  # workspace id takes letters, digits, dots and dashes, so the suite's
  # folders, a mode's `+` and a variant's `@runtime` are spelled out.
  wsid=$(printf 'rt-%s-%s' "$suite" "$(jq -r '.id' <<<"$case_json")" \
    | sed 's/+/plus/g' | tr '/_@' '---')
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

  local shell_args=(shell -w "$wsid")
  session_id=$(jq -r '.session_id // empty' <<<"$world_json")
  if [ -n "$session_id" ]; then
    if ! $cli session create "$wsid" --id "$session_id" \
        >"$work/session.out" 2>&1 </dev/null; then
      failures+=("$case_id: session create failed: $(head -c 300 "$work/session.out")")
      $cli workspace delete "$wsid" >/dev/null 2>&1 </dev/null || true
      return 1
    fi
    shell_args+=(--session "$session_id")
  fi

  # Seed declared mount files through the shell (cat reads the piped
  # stdin, the redirect writes the mount). A nested seed name needs its
  # parent first: the redirect refuses a missing directory, and it
  # refuses silently here, which reads as a file that was never
  # declared (run.py and run.ts mkdir the parent the same way).
  local prefix name quoted_path quoted_parent ok=0
  while IFS=$'\t' read -r prefix name; do
    [ -n "$prefix" ] || continue
    quoted_path=$(jq -nr --arg path "$prefix/$name" '$path | @sh')
    case "$name" in
      */*)
        quoted_parent=$(jq -nr --arg path "$prefix/${name%/*}" '$path | @sh')
        $cli "${shell_args[@]}" -c "mkdir -p $quoted_parent" \
          >/dev/null </dev/null || return 1
        ;;
    esac
    jq -j --arg p "$prefix" --arg n "$name" \
      '.world.mounts[$p].files[$n]' <<<"$case_json" \
      | $cli "${shell_args[@]}" -c "cat > $quoted_path" >/dev/null || return 1
  done < <(jq -r '(.world.mounts // {}) | to_entries[]
                  | .key as $p | (.value.files // {}) | keys[]
                  | [$p, .] | @tsv' <<<"$case_json")

  local steps step cmd script runtime expect got_exit
  steps=$(jq -c '.steps[]' <<<"$case_json")
  local index=0
  while IFS= read -r step; do
    cmd=$(jq -r '.command' <<<"$step")
    script=$(jq -r '.script // empty' <<<"$step")
    if [ -n "$script" ]; then
      cmd+=" $(jq -Rrs '@sh' "$SUITE_DIR/../fixtures/runtime/$script")"
    fi
    runtime=$(jq -r '.runtime // empty' <<<"$step")
    expect=$(jq -c '.expect // {}' <<<"$step")
    local args=("${shell_args[@]}" -c "$cmd")
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

# The line naming a CLI's error: a python traceback prints it last and a
# node stack first, each with frames around it.
error_line() {
  grep -m1 -E '^[A-Za-z.]*(Error|Exception|Unreachable)\b' "$1" || tail -n 1 "$1"
}

run_host() {
  local cli="$1" host="$2" port="$3" lane="$4"
  local home work
  home="$(mktemp -d "/tmp/rt-cli-$host-$lane-home.XXXXXX")"
  work="$(mktemp -d "/tmp/rt-cli-$host-$lane-work.XXXXXX")"
  export MIRAGE_HOME="$home"
  unset MIRAGE_DAEMON_PORT MIRAGE_DAEMON_URL MIRAGE_ALLOWED_HOSTS \
    MIRAGE_AUTH_MODE 2>/dev/null || true
  $cli config set port "$port" >/dev/null </dev/null
  $cli config set url "http://127.0.0.1:$port" >/dev/null </dev/null

  # The CLI spawns its daemon on the first create and gives it 5 s to answer.
  # On a busy runner the python daemon takes longer, and the lane's first
  # case failed on that alone. One throwaway create starts it; a create that
  # gave up still left the daemon starting, so wait for it to answer instead
  # of spawning another. A create that failed is printed either way, and a
  # daemon that never answers fails the lane.
  write_world_yaml '{}' "$work"
  local warm_created=1 ready=0 tries
  $cli workspace create "$work/ws.yaml" --id rt-warm >"$work/warm.out" 2>&1 </dev/null \
    || warm_created=0
  for tries in $(seq 1 60); do
    if $cli workspace list >/dev/null 2>"$work/warm_list.err" </dev/null; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ "$warm_created" = 0 ]; then
    echo "note $host lane $lane: warm-up create failed: $(error_line "$work/warm.out")"
  fi
  if [ "$ready" = 0 ]; then
    failures+=("$host lane $lane: daemon never answered after 60 s: $(error_line "$work/warm_list.err")")
    fail=$((fail + 1))
  elif [ "$warm_created" = 1 ] && \
      ! $cli workspace delete rt-warm >"$work/warm.out" 2>&1 </dev/null; then
    echo "note $host lane $lane: warm-up delete failed: $(error_line "$work/warm.out")"
  fi

  local file suite suite_json requires unmet only claim
  while IFS= read -r file <&3; do
    suite_json=$(cat "$SUITE_DIR/$file")
    suite="${file%.json}"
    if [ "${#ONLY_SUITES[@]}" -gt 0 ]; then
      local picked=0
      for only in "${ONLY_SUITES[@]}"; do
        if [ "$suite" = "$only" ] || [[ "$suite" == "$only/"* ]]; then picked=1; fi
      done
      [ "$picked" = 1 ] || continue
    fi
    # Whichever of the host's lanes reaches a suite first runs it: mkdir
    # either creates the claim or fails because another lane already did.
    # Any other failure would drop the suite from both lanes, so it counts.
    claim="$RESULT_DIR/claims/$host-${suite//\//-}"
    if ! mkdir "$claim" 2>/dev/null; then
      if [ ! -d "$claim" ]; then
        failures+=("$host/$suite: could not claim the suite")
        fail=$((fail + 1))
      fi
      continue
    fi
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
    # The per-host logs print only after both hosts finish, so a suite's
    # cost is not otherwise recoverable from the run.
    local suite_t0=$SECONDS
    local listed case_json case_id
    while IFS= read -r listed; do
      if ! jq -e --arg h "$host" \
          '(.hosts // ["python", "typescript"]) | index($h)' \
          >/dev/null <<<"$listed"; then
        continue
      fi
      while IFS= read -r case_json; do
        case_id=$(jq -r '.id' <<<"$case_json")
        unmet=""
        for req in $(jq -r '(.requires // [])[]' <<<"$case_json"); do
          requirement_met "$req" || unmet="$unmet $req"
        done
        if [ -n "$unmet" ]; then
          if [ "$STRICT" == "1" ] && \
              [ "$(jq -r '.optional // false' <<<"$case_json")" != "true" ]; then
            failures+=("$host/$suite/$case_id: unmet requirements$unmet (INTEG_RUNTIME_STRICT=1)")
            fail=$((fail + 1))
          else
            echo "skip $host/$suite/$case_id (unmet:$unmet)"
            skipped=$((skipped + 1))
          fi
          continue
        fi
        if ! cli_expressible "$case_json"; then
          echo "skip $host/$suite/$case_id (sdk-only)"
          skipped=$((skipped + 1))
          continue
        fi
        if run_case "$cli" "$host" "$suite" "$case_json" "$work"; then
          echo "ok $host/$suite/$case_id"
          pass=$((pass + 1))
        else
          echo "FAIL $host/$suite/$case_id"
          fail=$((fail + 1))
        fi
      done < <(runtime_variants "$listed" "$host")
    done < <(jq -c '.cases[]' <<<"$suite_json")
    echo "suite $host/$suite $((SECONDS - suite_t0))s"
  done 3< <(cd "$SUITE_DIR" && find . -name '*.json' | sed 's|^\./||' | sort)

  $cli daemon stop >/dev/null 2>&1 </dev/null || true
  sleep 1

  # Each lane runs in its own subshell, so its tally has to leave through
  # the filesystem: a subshell's variables die with it.
  printf '%s %s %s\n' "$pass" "$fail" "$skipped" > "$RESULT_DIR/$host.$lane.tally"
  : > "$RESULT_DIR/$host.$lane.failures"
  for line in "${failures[@]:-}"; do
    [ -n "$line" ] && printf '%s\n' "$line" >> "$RESULT_DIR/$host.$lane.failures"
  done
}

# Every lane is independent: its own daemon port and MIRAGE_HOME, and only
# ram mounts reach the CLI (see cli_expressible), so no two share a store.
# The docker suite is the one thing the hosts do share, and its cases are
# stateless execs (echo, exit, wc, uname) rather than writes, so two
# `docker exec` sessions in the one container cannot collide. Two lanes per
# host keep a 4-core runner busy, where one host's suites in a row left the
# longest step of the integ workflow waiting on a single process.
RESULT_DIR="$(mktemp -d "/tmp/rt-cli-results.XXXXXX")"
mkdir "$RESULT_DIR/claims"
LANES=(0 1)

pids=()
for lane in "${LANES[@]}"; do
  (run_host "$PY_CLI" "python" $((8791 + 2 * lane)) "$lane") \
    > "$RESULT_DIR/python.$lane.log" 2>&1 &
  pids+=($!)
  (run_host "$TS_CLI" "typescript" $((8792 + 2 * lane)) "$lane") \
    > "$RESULT_DIR/typescript.$lane.log" 2>&1 &
  pids+=($!)
done
for pid in "${pids[@]}"; do
  wait "$pid"
done

# Printed per lane rather than interleaved, which is what makes a failure
# readable: the lanes would otherwise write over each other's lines.
for host in python typescript; do
  for lane in "${LANES[@]}"; do
    echo "=== $host (lane $lane) ==="
    cat "$RESULT_DIR/$host.$lane.log"
  done
done

pass=0
fail=0
skipped=0
failures=()
for host in python typescript; do
  for lane in "${LANES[@]}"; do
    if [ ! -s "$RESULT_DIR/$host.$lane.tally" ]; then
      failures+=("$host lane $lane: no tally written (it died before finishing)")
      fail=$((fail + 1))
      continue
    fi
    read -r lane_pass lane_fail lane_skipped < "$RESULT_DIR/$host.$lane.tally"
    pass=$((pass + lane_pass))
    fail=$((fail + lane_fail))
    skipped=$((skipped + lane_skipped))
    while IFS= read -r line; do
      [ -n "$line" ] && failures+=("$line")
    done < "$RESULT_DIR/$host.$lane.failures"
  done
done

echo ""
echo "$pass passed, $fail failed, $skipped skipped"
for line in "${failures[@]:-}"; do
  [ -n "$line" ] && echo "  $line"
done
[ "$fail" -eq 0 ]
