#!/usr/bin/env bash
# CLI runtime battery. Verifies the yaml `runtime:` block end to end
# through each daemon: the default python runtime executes python3 against
# a mounted file, the default named explicitly in yaml works, a
# non-default runtime is honored, a cross-language runtime name
# ('pyodide' on Python, 'local' on TypeScript) is rejected at workspace
# create with a helpful message, and a per-mount command_safeguards
# timeout guards python3 like any other command (exit 124).
#
# Usage: cli_runtime.sh "<py-cli>" "<ts-cli>"
set -uo pipefail

PY_CLI="${1:?python mirage cli command}"
TS_CLI="${2:?typescript mirage cli command}"
fail=0

probe() {
  local cli="$1" lang="$2" port="$3" explicit="$4" selected="$5" invalid="$6"
  local home work
  home="$(mktemp -d "/tmp/cli-runtime-$lang-home.XXXXXX")"
  work="$(mktemp -d "/tmp/cli-runtime-$lang-work.XXXXXX")"
  export MIRAGE_HOME="$home"
  unset MIRAGE_PID_FILE MIRAGE_VERSION_ROOT MIRAGE_SNAPSHOT_ROOT \
    MIRAGE_DAEMON_PORT MIRAGE_DAEMON_URL MIRAGE_ALLOWED_HOSTS \
    MIRAGE_AUTH_MODE 2>/dev/null || true

  $cli config set port "$port" >/dev/null </dev/null
  $cli config set url "http://127.0.0.1:$port" >/dev/null </dev/null

  # --- default runtime: python3 reads a mounted file ---
  cat > "$work/default.yaml" <<YML
mode: EXEC
mounts:
  /data:
    resource: ram
YML
  $cli workspace create "$work/default.yaml" --id rt1 >/dev/null </dev/null
  $cli execute -w rt1 -c 'echo hi-from-vfs > /data/f.txt' </dev/null >/dev/null
  echo "default_py3=$($cli execute -w rt1 -c "python3 -c \"from pathlib import Path; print(Path('/data/f.txt').read_text().strip())\"" </dev/null | grep -o hi-from-vfs | head -1)"

  # --- node/js: both daemons run the same inline script on quickjs and
  # print 42 (ts bundles quickjs-emscripten; py loads qjs-wasi.wasm from
  # MIRAGE_QUICKJS_HOME). Proves the daemon threads the js runtime
  # through to the command identically in both languages.
  echo "js_out=$($cli execute -w rt1 -c "js -e \"console.log(6 * 7)\"" </dev/null 2>&1 | grep -oE '(^|[^0-9])42([^0-9]|$)' | grep -oE '42' | head -1)"

  # --- the language's default runtime configured explicitly in yaml ---
  cat > "$work/explicit.yaml" <<YML
mode: EXEC
runtime:
  python: $explicit
mounts:
  /data:
    resource: ram
YML
  $cli workspace create "$work/explicit.yaml" --id rt-explicit >/dev/null </dev/null
  echo "explicit_py3=$($cli execute -w rt-explicit -c "python3 -c \"print('explicit-runtime-ok')\"" </dev/null | grep -o 'explicit-runtime-ok' | head -1)"

  # --- explicitly selected runtime ---
  cat > "$work/selected.yaml" <<YML
mode: EXEC
runtime:
  python: $selected
mounts:
  /data:
    resource: ram
YML
  $cli workspace create "$work/selected.yaml" --id rt2 >/dev/null </dev/null
  if [ "$selected" == "local" ]; then
    # local is the host CPython: sys.argv exists there and not under monty.
    echo "selected_py3=$($cli execute -w rt2 -c "python3 -c \"import sys; print('argv-len', len(sys.argv))\"" </dev/null | grep -o 'argv-len 1' | head -1)"
  else
    $cli execute -w rt2 -c 'echo hi-from-vfs > /data/g.txt' </dev/null >/dev/null
    echo "selected_py3=$($cli execute -w rt2 -c "python3 -c \"from pathlib import Path; print(Path('/data/g.txt').read_text().strip())\"" </dev/null | grep -o hi-from-vfs | head -1)"
  fi

  # --- command_safeguards timeout guards python3 like any command ---
  cat > "$work/safeguard.yaml" <<YML
mode: EXEC
runtime:
  python: monty
mounts:
  /data:
    resource: ram
    command_safeguards:
      python3:
        timeout_seconds: 1
YML
  $cli workspace create "$work/safeguard.yaml" --id rtsg >/dev/null </dev/null
  $cli execute -w rtsg -c "echo 'n = 0' > /data/slow.py && echo 'for i in range(300000000):' >> /data/slow.py && echo '    n = n + 1' >> /data/slow.py" </dev/null >/dev/null
  $cli execute -w rtsg -c "python3 /data/slow.py" \
    >/tmp/cli-runtime-$lang-sg.txt 2>&1 </dev/null
  echo "sg_exec=exit$?"
  echo "sg_msg=$(grep -o 'python3: timed out after' /tmp/cli-runtime-$lang-sg.txt | head -1)"

  # --- the other language's runtime name is rejected with a hint ---
  cat > "$work/invalid.yaml" <<YML
mode: EXEC
runtime:
  python: $invalid
mounts:
  /data:
    resource: ram
YML
  $cli workspace create "$work/invalid.yaml" --id rt3 \
    >/tmp/cli-runtime-$lang-invalid.txt 2>&1 </dev/null
  echo "invalid_create=exit$?"
  echo "invalid_msg=$(grep -oE 'TypeScript-only|Python-only' /tmp/cli-runtime-$lang-invalid.txt | head -1)"

  # --- per-runtime option blocks: py validates the wasi build dir at
  # create (portable pyodide block ignored); ts ignores the portable
  # wasi block but rejects an unknown option key on the selected
  # runtime ---
  if [ "$lang" == "py" ]; then
    cat > "$work/wasip.yaml" <<YML
mode: EXEC
runtime:
  python: wasi
  wasi:
    home: /nonexistent-wasi-build
  pyodide:
    home: https://assets.example.com/pyodide/
mounts:
  /data:
    resource: ram
YML
  else
    cat > "$work/wasip.yaml" <<YML
mode: EXEC
runtime:
  python: pyodide
  wasi:
    home: /nonexistent-wasi-build
  pyodide:
    homee: /typo-key
mounts:
  /data:
    resource: ram
YML
  fi
  $cli workspace create "$work/wasip.yaml" --id rtwp \
    >/tmp/cli-runtime-$lang-wasip.txt 2>&1 </dev/null
  echo "wasip_create=exit$?"
  echo "wasip_msg=$(grep -oE 'cpython-wasi-build|unknown pyodide runtime option' /tmp/cli-runtime-$lang-wasip.txt | head -1)"

  $cli daemon stop >/dev/null 2>&1 </dev/null || true
  sleep 1
}

# Wasm sandbox mount access (Python daemon only: the py wasi/quickjs
# runtimes intercept the guest's filesystem imports and bridge them
# through the workspace dispatch, so sandboxed python3/js code reads AND
# writes virtual mounts with no FUSE and no host directory. TS quickjs
# is quickjs-emscripten (no mount bridge), a documented gap, hence no
# ts probe.
sandbox_probe() {
  local cli="$1"
  local yaml="/tmp/cli-runtime-sbx.yaml"
  cat > "$yaml" <<YML
mode: EXEC
runtime:
  python: wasi
mounts:
  /data:
    resource: ram
YML
  $cli workspace delete sbx >/dev/null 2>&1 </dev/null || true
  $cli workspace create "$yaml" --id sbx >/dev/null </dev/null
  $cli execute -w sbx -c 'echo sandbox-sees-me > /data/probe.txt' </dev/null >/dev/null
  echo "sbx_js_read=$($cli execute -w sbx -c "js -e \"const f = std.open('/data/probe.txt', 'r'); console.log(f.readAsString().trim())\"" </dev/null | grep -o sandbox-sees-me | head -1)"
  echo "sbx_py3_read=$($cli execute -w sbx -c "python3 -c \"print(open('/data/probe.txt').read().strip() + '-py')\"" </dev/null | grep -o 'sandbox-sees-me-py' | head -1)"
  $cli execute -w sbx -c "python3 -c \"open('/data/from-py.txt', 'w').write('py-wrote-this\\n')\"" </dev/null >/dev/null
  echo "sbx_py3_write=$($cli execute -w sbx -c 'cat /data/from-py.txt' </dev/null | grep -o py-wrote-this | head -1)"
  $cli execute -w sbx -c "js -e \"const w = std.open('/data/from-js.txt', 'w'); w.puts('js-wrote-this\\n'); w.close()\"" </dev/null >/dev/null
  echo "sbx_js_write=$($cli execute -w sbx -c 'cat /data/from-js.txt' </dev/null | grep -o js-wrote-this | head -1)"
  $cli execute -w sbx -c "python3 -c \"import os; os.mkdir('/data/sub'); open('/data/sub/n.txt','w').write('nested'); os.rename('/data/sub/n.txt','/data/sub/m.txt')\"" </dev/null >/dev/null
  echo "sbx_py3_dirops=$($cli execute -w sbx -c 'cat /data/sub/m.txt' </dev/null | grep -o nested | head -1)"
  $cli workspace delete sbx >/dev/null 2>&1 </dev/null || true
  rm -f "$yaml"
}

echo "===== python cli ====="
probe "$PY_CLI" py 9430 monty local pyodide | tee /tmp/cli-runtime-py.txt

SANDBOX_EXPECT=no
if [ -f "${MIRAGE_QUICKJS_HOME:-/nonexistent}/qjs-wasi.wasm" ] \
    && [ -f "${MIRAGE_WASI_HOME:-/nonexistent}/python.wasm" ]; then
  echo
  echo "===== wasm sandbox mount access (python daemon) ====="
  export MIRAGE_HOME
  MIRAGE_HOME="$(mktemp -d /tmp/cli-runtime-sbx-home.XXXXXX)"
  "$PY_CLI" config set port 9431 >/dev/null </dev/null
  "$PY_CLI" config set url "http://127.0.0.1:9431" >/dev/null </dev/null
  sandbox_probe "$PY_CLI" | tee -a /tmp/cli-runtime-py.txt
  "$PY_CLI" daemon stop >/dev/null 2>&1 </dev/null || true
  sleep 1
  SANDBOX_EXPECT=yes
else
  echo
  echo "skipping wasm sandbox probes (no qjs-wasi.wasm / python.wasm)"
fi

echo
echo "===== typescript cli ====="
probe "$TS_CLI" ts 9440 pyodide monty local | tee /tmp/cli-runtime-ts.txt

echo
echo "===== expected values ====="
expect() {
  local file="$1" key="$2" want="$3"
  local got
  got="$(grep -F "$key=" "$file" | head -1 | cut -d= -f2-)"
  if [ "$got" == "$want" ]; then
    echo "  OK   $file $key == $(printf '%q' "$want")"
  else
    echo "  FAIL $file $key: got $(printf '%q' "$got") expected $(printf '%q' "$want")"
    fail=1
  fi
}

expect /tmp/cli-runtime-py.txt "default_py3" "hi-from-vfs"
expect /tmp/cli-runtime-py.txt "explicit_py3" "explicit-runtime-ok"
expect /tmp/cli-runtime-py.txt "selected_py3" "argv-len 1"
expect /tmp/cli-runtime-py.txt "invalid_msg" "TypeScript-only"
expect /tmp/cli-runtime-py.txt "sg_exec" "exit124"
expect /tmp/cli-runtime-py.txt "sg_msg" "python3: timed out after"
expect /tmp/cli-runtime-py.txt "wasip_msg" "cpython-wasi-build"
expect /tmp/cli-runtime-py.txt "js_out" "42"
if [ "$SANDBOX_EXPECT" == "yes" ]; then
  expect /tmp/cli-runtime-py.txt "sbx_js_read" "sandbox-sees-me"
  expect /tmp/cli-runtime-py.txt "sbx_py3_read" "sandbox-sees-me-py"
  expect /tmp/cli-runtime-py.txt "sbx_py3_write" "py-wrote-this"
  expect /tmp/cli-runtime-py.txt "sbx_js_write" "js-wrote-this"
  expect /tmp/cli-runtime-py.txt "sbx_py3_dirops" "nested"
fi
expect /tmp/cli-runtime-ts.txt "default_py3" "hi-from-vfs"
expect /tmp/cli-runtime-ts.txt "explicit_py3" "explicit-runtime-ok"
expect /tmp/cli-runtime-ts.txt "selected_py3" "hi-from-vfs"
expect /tmp/cli-runtime-ts.txt "invalid_msg" "Python-only"
expect /tmp/cli-runtime-ts.txt "sg_exec" "exit124"
expect /tmp/cli-runtime-ts.txt "sg_msg" "python3: timed out after"
expect /tmp/cli-runtime-ts.txt "wasip_msg" "unknown pyodide runtime option"
expect /tmp/cli-runtime-ts.txt "js_out" "42"

py_invalid="$(grep -F 'invalid_create=' /tmp/cli-runtime-py.txt | head -1 | cut -d= -f2-)"
ts_invalid="$(grep -F 'invalid_create=' /tmp/cli-runtime-ts.txt | head -1 | cut -d= -f2-)"
for pair in "py:$py_invalid" "ts:$ts_invalid"; do
  if [ "${pair#*:}" == "exit0" ]; then
    echo "  FAIL ${pair%%:*} invalid runtime was accepted (exit0)"
    fail=1
  else
    echo "  OK   ${pair%%:*} invalid runtime rejected (${pair#*:})"
  fi
done

if [ "$fail" != "0" ]; then
  echo
  echo "CLI runtime battery FAILED."
  exit 1
fi
echo
echo "CLI runtime battery OK (default runtime, explicit yaml default, yaml selection, safeguard timeout, cross-language rejection; py + ts)."
