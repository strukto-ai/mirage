#!/usr/bin/env bash
# CLI env-plane battery: a workspace YAML carries an `env:` block with
# literal and managed entries, created through the real door (`mirage
# workspace create` reads the YAML, sends the checked config to the
# daemon, and the daemon builds the workspace), and both hosts must
# answer every probe identically. Managed entries use the two builtin
# sources a bare daemon can serve with no fake service (`env` reads the
# daemon's own process environment, which it inherits from the CLI that
# spawned it; `dotenv` a file the battery writes). Probes: a literal
# expands, a readonly preset refuses with bash's wording, a lazy managed
# name fetches on first reference, printenv (a whole-env command)
# fetches a name the line never spells, an agent write detaches so the
# next CLI invocation reads the session's value, and a bad entry (value
# beside from) is refused at create.
#
# Usage: cli_env.sh "<py-cli>" "<ts-cli>"
set -uo pipefail

PY_CLI="${1:?python mirage cli command}"
TS_CLI="${2:?typescript mirage cli command}"
fail=0

probe() {
  local cli="$1" lang="$2" port="$3"
  local home work
  home="$(mktemp -d "/tmp/cli-env-$lang-home.XXXXXX")"
  work="$(mktemp -d "/tmp/cli-env-$lang-work.XXXXXX")"
  export MIRAGE_HOME="$home"
  # The `env` source reads the daemon's process environment; the daemon
  # inherits this from whichever CLI call spawns it, so it is exported
  # for the whole probe rather than prefixed onto one command.
  export MIRAGE_CLI_ENV_SECRET=sec-daemon-env-v1
  unset MIRAGE_DAEMON_PORT MIRAGE_DAEMON_URL MIRAGE_ALLOWED_HOSTS \
    MIRAGE_AUTH_MODE 2>/dev/null || true

  printf 'DOTFILE_SECRET=sec-dotfile-v1\n' > "$work/cli.env"
  local yaml="$work/env.yaml"
  cat > "$yaml" <<YML
mode: WRITE
mounts:
  /data:
    resource: ram
env:
  APP_NAME: lit-app-name
  EDITOR:
    value: vi
    readonly: true
  FROM_ENV:
    from: env
    key: MIRAGE_CLI_ENV_SECRET
  FROM_DOTFILE:
    from: dotenv
    ref: $work/cli.env
    key: DOTFILE_SECRET
YML

  $cli config set port "$port" >/dev/null </dev/null
  $cli config set url "http://127.0.0.1:$port" >/dev/null </dev/null

  $cli workspace delete env1 >/dev/null 2>&1 </dev/null || true
  $cli workspace create "$yaml" --id env1 >/dev/null </dev/null
  echo "create=exit$?"

  # `execute` prints a JSON envelope carrying the streams, and the two
  # hosts spell its keys differently, so every probe greps a distinctive
  # value out of it rather than reading lines (cli_config.sh's pattern).
  echo "literal=$($cli execute -w env1 -c 'echo $APP_NAME' </dev/null | grep -o 'lit-app-name' | head -1)"

  $cli execute -w env1 -c 'EDITOR=x' >"/tmp/cli-env-$lang-ro.txt" 2>&1 </dev/null
  echo "readonly_write=exit$?"
  echo "readonly_msg=$(grep -o 'EDITOR: readonly variable' "/tmp/cli-env-$lang-ro.txt" | head -1)"

  echo "dotenv=$($cli execute -w env1 -c 'echo $FROM_DOTFILE' </dev/null | grep -o 'sec-dotfile-v1' | head -1)"
  # printenv is a whole-env command: FROM_ENV has not been referenced
  # yet, and the operand word is not a $-reference the fill walk could
  # see, so this proves the whole-env fetch of an unspelled name.
  echo "wholeenv=$($cli execute -w env1 -c 'printenv FROM_ENV' </dev/null | grep -o 'sec-daemon-env-v1' | head -1)"

  $cli execute -w env1 -c 'export FROM_ENV=sec-rewritten' >/dev/null </dev/null
  echo "detach_write=exit$?"
  # A separate CLI invocation: the detached value is served from the
  # daemon's session, never refetched from the source.
  echo "detach_read=$($cli execute -w env1 -c 'echo $FROM_ENV' </dev/null | grep -o 'sec-rewritten' | head -1)"
  echo "detach_env_row=$($cli execute -w env1 -c 'env' </dev/null | grep -o 'FROM_ENV=sec-rewritten' | head -1)"

  cat > "$work/bad.yaml" <<YML
mounts:
  /data:
    resource: ram
env:
  X:
    value: v
    from: env
YML
  $cli workspace create "$work/bad.yaml" --id env2 >/dev/null 2>"/tmp/cli-env-$lang-bad.txt" </dev/null
  local bad_code=$?
  echo "bad_entry=$([ "$bad_code" != "0" ] && echo refused || echo created)"
  echo "bad_entry_msg=$(grep -o 'not both' "/tmp/cli-env-$lang-bad.txt" | head -1)"

  $cli daemon stop >/dev/null 2>&1 </dev/null || true
  sleep 1
  unset MIRAGE_HOME MIRAGE_CLI_ENV_SECRET
  rm -rf "$home" "$work"
}

echo "===== probing Python CLI ====="
probe "$PY_CLI" py 9430 | sort > /tmp/cli-env-py.txt
echo "===== probing TypeScript CLI ====="
probe "$TS_CLI" ts 9440 | sort > /tmp/cli-env-ts.txt

echo
echo "===== Python results ====="
cat /tmp/cli-env-py.txt

echo
echo "===== language parity (py vs ts) ====="
if diff -u /tmp/cli-env-py.txt /tmp/cli-env-ts.txt; then
  echo "  OK   Python and TypeScript produced identical results"
else
  echo "  FAIL Python and TypeScript diverged"
  fail=1
fi

echo
echo "===== expected values ====="
expect() {
  local key="$1" want="$2"
  local got
  got="$(grep -F "$key=" /tmp/cli-env-py.txt | head -1 | cut -d= -f2-)"
  if [ "$got" == "$want" ]; then
    echo "  OK   $key == $(printf '%q' "$want")"
  else
    echo "  FAIL $key: got $(printf '%q' "$got") expected $(printf '%q' "$want")"
    fail=1
  fi
}
expect "create" "exit0"
expect "literal" "lit-app-name"
expect "readonly_write" "exit1"
expect "readonly_msg" "EDITOR: readonly variable"
expect "dotenv" "sec-dotfile-v1"
expect "wholeenv" "sec-daemon-env-v1"
expect "detach_write" "exit0"
expect "detach_read" "sec-rewritten"
expect "detach_env_row" "FROM_ENV=sec-rewritten"
expect "bad_entry" "refused"
expect "bad_entry_msg" "not both"

if [ "$fail" != "0" ]; then
  echo
  echo "CLI env battery FAILED."
  exit 1
fi
echo
echo "CLI env battery OK (literal + readonly presets, env/dotenv managed sources, whole-env fetch, detach-on-write; py == ts)."
