#!/usr/bin/env bash
# Cross-language CLI feature parity. Runs the SAME battery of commands on the
# Python CLI and the TypeScript CLI, records normalized results per language,
# then asserts (1) the two languages produce identical results and (2) the
# results match the expected values. Covers subshell isolation, sessions,
# git-backed versioning, and fuse config wiring. Uses RAM mounts only (no
# redis/minio/fuse kernel deps), so it runs anywhere both CLIs are built.
#
# Usage: parity.sh "<py-cli>" "<ts-cli>"
set -uo pipefail

PY_CLI="${1:?python mirage cli command}"
TS_CLI="${2:?typescript mirage cli command}"
HERE="$(cd "$(dirname "$0")" && pwd)"
fail=0

YAML=/tmp/parity-ws.yaml
cat > "$YAML" <<'YML'
mounts:
  /:
    resource: ram
    mode: WRITE
YML

FUSE_YAML=/tmp/parity-fuse.yaml
cat > "$FUSE_YAML" <<'YML'
mode: WRITE
mounts:
  /:
    resource: ram
    fuse: true
YML

freeport() { lsof -ti:8765 2>/dev/null | xargs kill -9 2>/dev/null; sleep 1; }
sout() { jq -r '.stdout // .result.stdout // empty'; }
sexit() { jq -r '.exit_code // .exitCode // .result.exit_code // empty'; }

# Run the full battery against one CLI; emit one "key=value" line per probe.
probe() {
  local cli="$1" lang="$2"
  export MIRAGE_VERSION_ROOT="/tmp/parity-repos-$lang"
  rm -rf "$MIRAGE_VERSION_ROOT"
  freeport
  $cli daemon stop >/dev/null 2>&1 </dev/null || true
  sleep 1

  $cli workspace delete pw >/dev/null 2>&1 </dev/null || true
  $cli workspace create "$YAML" --id pw >/dev/null </dev/null
  $cli execute -w pw -c 'mkdir -p /data' </dev/null >/dev/null

  # ── subshell: cd / export must not leak; exit + pipe ──
  echo "subshell.cd_inner=$($cli execute -w pw -c '(cd /data && pwd)' </dev/null | sout)"
  echo "subshell.cd_after=$($cli execute -w pw -c 'pwd' </dev/null | sout)"
  echo "subshell.export_inner=$($cli execute -w pw -c '(export FOO=bar; echo $FOO)' </dev/null | sout)"
  echo "subshell.export_after=$($cli execute -w pw -c 'echo [$FOO]' </dev/null | sout)"
  echo "subshell.false_exit=$($cli execute -w pw -c '(false)' </dev/null | sexit)"
  echo "subshell.pipe=$($cli execute -w pw -c '(echo a; echo b) | wc -l' </dev/null | sout)"
  echo "subshell.oldpwd_no_leak=$($cli execute -w pw -c '(cd /data && (cd /) && echo $OLDPWD)' </dev/null | sout)"
  echo "subshell.func_redef=$($cli execute -w pw -c '(f(){ echo A; }; (f(){ echo B; }); f)' </dev/null | sout)"
  echo "subshell.func_no_leak=$($cli execute -w pw -c '(nofn(){ echo x; }); nofn 2>/dev/null || echo gone' </dev/null | sout)"
  echo "subshell.positional=$($cli execute -w pw -c '(set -- a b c; (set -- x); echo $#)' </dev/null | sout)"

  # ── cwd/env: HOME, PWD, OLDPWD, cd -, tilde (GNU cd + pwd) ──
  $cli execute -w pw -c 'echo hi > /data/f.txt' </dev/null >/dev/null
  echo "cwd.home_default=$($cli execute -w pw -c 'echo $HOME' </dev/null | sout)"
  echo "cwd.pwd_var=$($cli execute -w pw -c '(cd /data && echo $PWD)' </dev/null | sout)"
  echo "cwd.oldpwd=$($cli execute -w pw -c '(cd /data && cd / && echo $OLDPWD)' </dev/null | sout)"
  echo "cwd.cd_dash=$($cli execute -w pw -c '(cd /data && cd / && cd -)' </dev/null | sout)"
  echo "cwd.tilde_pwd=$($cli execute -w pw -c '(export HOME=/data && cd ~ && pwd)' </dev/null | sout)"
  echo "cwd.tilde_cat=$($cli execute -w pw -c '(export HOME=/data && cat ~/f.txt)' </dev/null | sout)"
  echo "cwd.rel_cat=$($cli execute -w pw -c '(cd /data && cat f.txt)' </dev/null | sout)"
  echo "cwd.wc_disp=$($cli execute -w pw -c '(cd /data && wc -l f.txt)' </dev/null | sout)"

  # ── sessions: default session persists cwd; -s session is isolated ──
  $cli session create pw --id s2 </dev/null >/dev/null
  $cli execute -w pw -c 'cd /data' </dev/null >/dev/null
  echo "session.default_pwd=$($cli execute -w pw -c 'pwd' </dev/null | sout)"
  echo "session.s2_pwd=$($cli execute -w pw -s s2 -c 'pwd' </dev/null | sout)"

  $cli workspace delete pw >/dev/null 2>&1 </dev/null || true

  # ── versioning: commit/branch/log/clone/checkout/diff (git-backed) ──
  $cli workspace delete vw >/dev/null 2>&1 </dev/null || true
  $cli workspace create "$YAML" --id vw >/dev/null </dev/null
  $cli execute -w vw -c 'echo one > /a.txt' </dev/null >/dev/null
  $cli workspace commit vw -m first </dev/null >/dev/null
  $cli workspace branch vw feature </dev/null >/dev/null    # feature @ first
  $cli execute -w vw -c 'echo two > /a.txt' </dev/null >/dev/null
  $cli workspace commit vw -m second </dev/null >/dev/null  # main @ second
  echo "version.log=$($cli workspace log vw </dev/null | jq -r '[.[].message] | join(",")')"
  echo "version.branch_log=$($cli workspace log vw -b feature </dev/null | jq -r '[.[].message] | join(",")')"
  echo "ws.get_mounts=$($cli workspace get vw </dev/null | jq -r '[.mounts[].prefix] | join(",")')"
  echo "ws.list_has_vw=$($cli workspace list </dev/null | jq -r 'if (map(.id) | index("vw")) != null then "yes" else "no" end')"

  # clone live state (two), and clone from the first commit (one)
  $cli workspace delete vwc >/dev/null 2>&1 </dev/null || true
  $cli workspace clone vw --id vwc </dev/null >/dev/null
  echo "clone.content=$($cli execute -w vwc -c 'cat /a.txt' </dev/null | sout)"
  $cli workspace delete vwc >/dev/null 2>&1 </dev/null || true
  local first
  first="$($cli workspace log vw </dev/null | jq -r '.[-1].id')"
  $cli workspace delete vwa >/dev/null 2>&1 </dev/null || true
  $cli workspace clone vw --id vwa --at "$first" </dev/null >/dev/null
  echo "clone.at_first=$($cli execute -w vwa -c 'cat /a.txt' </dev/null | sout)"
  $cli workspace delete vwa >/dev/null 2>&1 </dev/null || true

  $cli workspace checkout vw "$first" </dev/null >/dev/null 2>&1
  echo "version.checkout_first=$($cli execute -w vw -c 'cat /a.txt' </dev/null | sout)"
  $cli workspace checkout vw main </dev/null >/dev/null 2>&1
  $cli execute -w vw -c 'echo three > /a.txt' </dev/null >/dev/null
  echo "version.diff=$($cli workspace diff vw </dev/null | jq -rc '{added,modified,deleted}')"
  $cli workspace delete vw >/dev/null 2>&1 </dev/null || true

  # ── fuse: fuse:true config is accepted and the workspace operates ──
  $cli workspace delete fw >/dev/null 2>&1 </dev/null || true
  $cli workspace create "$FUSE_YAML" --id fw >/dev/null </dev/null
  echo "fuse.operates=$($cli execute -w fw -c 'echo alive' </dev/null | sout)"
  $cli workspace delete fw >/dev/null 2>&1 </dev/null || true
  freeport
}

echo "===== probing Python CLI ====="
probe "$PY_CLI" py | sort > /tmp/parity-py.txt
echo "===== probing TypeScript CLI ====="
probe "$TS_CLI" ts | sort > /tmp/parity-ts.txt

echo
echo "===== Python results ====="
cat /tmp/parity-py.txt

echo
echo "===== language parity (py vs ts) ====="
if diff -u /tmp/parity-py.txt /tmp/parity-ts.txt; then
  echo "  OK   Python and TypeScript produced identical results"
else
  echo "  FAIL Python and TypeScript diverged (see diff above)"
  fail=1
fi

echo
echo "===== expected values ====="
expect() {
  local key="$1" want="$2"
  local got
  got="$(grep -F "$key=" /tmp/parity-py.txt | head -1 | cut -d= -f2-)"
  if [ "$got" == "$want" ]; then
    echo "  OK   $key == $(printf '%q' "$want")"
  else
    echo "  FAIL $key: got $(printf '%q' "$got") expected $(printf '%q' "$want")"
    fail=1
  fi
}
expect "subshell.cd_inner" "/data"
expect "subshell.cd_after" "/"
expect "subshell.export_inner" "bar"
expect "subshell.export_after" "[]"
expect "subshell.false_exit" "1"
expect "subshell.pipe" "2"
expect "subshell.oldpwd_no_leak" "/"
expect "subshell.func_redef" "A"
expect "subshell.func_no_leak" "gone"
expect "subshell.positional" "3"
expect "cwd.home_default" ""
expect "cwd.pwd_var" "/data"
expect "cwd.oldpwd" "/data"
expect "cwd.cd_dash" "/data"
expect "cwd.tilde_pwd" "/data"
expect "cwd.tilde_cat" "hi"
expect "cwd.rel_cat" "hi"
expect "cwd.wc_disp" "1 f.txt"
expect "session.default_pwd" "/data"
expect "session.s2_pwd" "/"
expect "version.log" "second,first"
expect "version.branch_log" "first"
expect "ws.get_mounts" "/"
expect "ws.list_has_vw" "yes"
expect "clone.content" "two"
expect "clone.at_first" "one"
expect "version.checkout_first" "one"
expect 'version.diff' '{"added":[],"modified":["a.txt"],"deleted":[]}'
expect "fuse.operates" "alive"

if [ "$fail" != "0" ]; then
  echo
  echo "CLI feature parity FAILED."
  exit 1
fi
echo
echo "CLI feature parity OK (subshell, sessions, versioning, fuse; py == ts)."
