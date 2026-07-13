#!/usr/bin/env bash
# CLI config battery. Part A relocates every daemon path setting through
# `mirage config set` (pid_file, version_root, snapshot_root, port + url),
# runs the real workspace workload (create, execute, commit, log, snapshot,
# readback), and asserts both that everything still works AND that the
# artifacts physically land in the configured locations, with nothing leaked
# to the defaults. It then moves version_root a second time and restarts to
# prove settings are re-read at startup (Docker data-root semantics). Part B
# covers the command surface: 0600 perms, unknown-key rejection with a clean
# message, a typo key making the daemon refuse to start until repaired with
# `config unset`, malformed TOML failing cleanly, resolved-view origins with
# auth_token masked, and env-beats-config proven by where bytes land.
#
# Usage: cli_config.sh "<py-cli>" "<ts-cli>"
set -uo pipefail

PY_CLI="${1:?python mirage cli command}"
TS_CLI="${2:?typescript mirage cli command}"
fail=0

probe() {
  local cli="$1" lang="$2" port="$3"
  local home work
  home="$(mktemp -d "/tmp/cli-config-$lang-home.XXXXXX")"
  work="$(mktemp -d "/tmp/cli-config-$lang-work.XXXXXX")"
  export MIRAGE_HOME="$home"
  unset MIRAGE_PID_FILE MIRAGE_VERSION_ROOT MIRAGE_SNAPSHOT_ROOT \
    MIRAGE_DAEMON_PORT MIRAGE_DAEMON_URL MIRAGE_ALLOWED_HOSTS \
    MIRAGE_AUTH_MODE 2>/dev/null || true

  local yaml="$work/ram.yaml"
  cat > "$yaml" <<YML
mode: WRITE
mounts:
  /data:
    resource: ram
YML

  # --- Part A: relocate everything, then run the real workload ---
  $cli config set pid_file "$work/custom.pid" >/dev/null </dev/null
  $cli config set version_root "$work/vroot" >/dev/null </dev/null
  $cli config set snapshot_root "$work/sroot" >/dev/null </dev/null
  $cli config set port "$port" >/dev/null </dev/null
  $cli config set url "http://127.0.0.1:$port" >/dev/null </dev/null
  echo "file_perms=$(stat -c '%a' "$home/config.toml" 2>/dev/null || stat -f '%Lp' "$home/config.toml")"

  $cli workspace delete cc >/dev/null 2>&1 </dev/null || true
  $cli workspace create "$yaml" --id cc >/dev/null </dev/null
  local health
  health="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/v1/health")"
  echo "relocate_health=$([ "$health" == "200" ] && echo ok || echo "$health")"
  echo "relocate_pid_custom=$([ -s "$work/custom.pid" ] && echo exists || echo absent)"
  echo "relocate_pid_default=$([ -e "$home/daemon.pid" ] && echo exists || echo absent)"

  $cli execute -w cc -c 'echo hello > /data/f.txt' </dev/null >/dev/null
  echo "relocate_readback=$($cli execute -w cc -c 'cat /data/f.txt' </dev/null | tail -c 200 | grep -o hello | head -1)"
  $cli workspace commit cc -m v1 >/dev/null </dev/null
  echo "relocate_repo_custom=$([ -d "$work/vroot/cc/objects" ] && echo exists || echo absent)"
  echo "relocate_repo_default=$([ -d "$home/repos" ] && echo exists || echo absent)"
  echo "relocate_log=$($cli workspace log cc </dev/null | grep -o v1 | head -1)"

  # Snapshots must land inside snapshot_root: a target outside it is refused,
  # a target under the relocated root is written there.
  if $cli workspace snapshot cc "$work/outside.tar" >/dev/null 2>&1 </dev/null; then
    echo "snapshot_outside_root=allowed"
  else
    echo "snapshot_outside_root=denied"
  fi
  $cli workspace snapshot cc "$work/sroot/out.tar" >/dev/null </dev/null
  echo "relocate_snapshot_custom=$([ -s "$work/sroot/out.tar" ] && echo exists || echo absent)"
  echo "relocate_snapshot_default=$([ -d "$home/snapshots" ] && echo exists || echo absent)"

  # --- settings are re-read on restart: move version_root again ---
  $cli daemon stop >/dev/null 2>&1 </dev/null || true
  sleep 1
  $cli config set version_root "$work/vroot2" >/dev/null </dev/null
  $cli workspace create "$yaml" --id cc2 >/dev/null </dev/null
  $cli workspace commit cc2 -m v2 >/dev/null </dev/null
  echo "remove_new_repo=$([ -d "$work/vroot2/cc2/objects" ] && echo exists || echo absent)"
  echo "remove_old_untouched=$([ -d "$work/vroot/cc/objects" ] && echo exists || echo absent)"
  echo "remove_new_not_in_old=$([ -d "$work/vroot/cc2" ] && echo leaked || echo clean)"

  # --- env beats config, proven by where the repo lands ---
  $cli daemon stop >/dev/null 2>&1 </dev/null || true
  sleep 1
  MIRAGE_VERSION_ROOT="$work/envroot" $cli workspace create "$yaml" --id cc3 >/dev/null </dev/null
  MIRAGE_VERSION_ROOT="$work/envroot" $cli workspace commit cc3 -m v3 >/dev/null </dev/null
  echo "env_beats_config_effective=$([ -d "$work/envroot/cc3/objects" ] && echo yes || echo no)"
  echo "env_config_dir_untouched=$([ -d "$work/vroot2/cc3" ] && echo leaked || echo clean)"
  $cli daemon stop >/dev/null 2>&1 </dev/null || true
  sleep 1

  # --- Part B: command surface ---
  echo "set_get=$($cli config get version_root </dev/null | tr -d '"{}: ' | grep -o vroot2 | head -1)"
  $cli config unset socket >/dev/null 2>&1 </dev/null
  echo "unset_unknown_ok=$($cli config unset typo_free >/dev/null 2>&1 </dev/null && echo exit0 || echo exit$?)"
  $cli config set MIRAGE_HOME /x >/dev/null 2>/tmp/cli-config-$lang-err.txt </dev/null
  echo "unknown_set=exit$?"
  echo "unknown_set_msg=$(grep -o 'unknown config key' /tmp/cli-config-$lang-err.txt | head -1)"
  echo "unknown_set_msg_clean=$(head -c1 /tmp/cli-config-$lang-err.txt | grep -q "'" && echo quoted || echo clean)"

  # A typo key bricks daemon startup with a clean, key-naming message.
  printf 'typo_key = "x"\n' >> "$home/config.toml"
  $cli workspace create "$yaml" --id cc4 >/dev/null 2>/tmp/cli-config-$lang-typo.txt </dev/null
  echo "typo_spawn=exit$?"
  echo "typo_spawn_msg=$(grep -o 'typo_key' /tmp/cli-config-$lang-typo.txt | head -1)"
  echo "typo_spawn_clean=$(grep -c 'Traceback' /tmp/cli-config-$lang-typo.txt)"
  $cli config list >/dev/null 2>/tmp/cli-config-$lang-warn.txt </dev/null
  echo "list_warns=$(grep -o 'typo_key' /tmp/cli-config-$lang-warn.txt | head -1)"
  $cli config unset typo_key >/dev/null </dev/null
  echo "repair_unset=exit$?"
  $cli workspace create "$yaml" --id cc5 >/dev/null 2>&1 </dev/null
  echo "start_after_repair=exit$?"
  $cli daemon stop >/dev/null 2>&1 </dev/null || true
  sleep 1

  # Malformed TOML: one clean line, exit 2, still repairable by rewriting.
  printf '[daemon\nnot toml\n' > "$home/config.toml"
  $cli config list >/dev/null 2>/tmp/cli-config-$lang-mal.txt </dev/null
  echo "malformed_list=exit$?"
  echo "malformed_msg=$(grep -o 'malformed' /tmp/cli-config-$lang-mal.txt | head -1)"
  rm -f "$home/config.toml"

  # The malformed file was removed wholesale; restore port + url so the
  # remaining daemon probes stay on this language's port.
  $cli config set port "$port" >/dev/null </dev/null
  $cli config set url "http://127.0.0.1:$port" >/dev/null </dev/null

  # Resolved view: origins for env / file / default, auth_token masked.
  $cli config set version_root /file/repos >/dev/null </dev/null
  local resolved
  resolved="$(MIRAGE_SNAPSHOT_ROOT=/env/snaps MIRAGE_TOKEN=supersecret $cli config list --resolved </dev/null)"
  echo "resolved_env_origin=$(printf '%s' "$resolved" | grep -o 'env MIRAGE_SNAPSHOT_ROOT' | head -1)"
  echo "resolved_file_value=$(printf '%s' "$resolved" | grep -o '/file/repos' | head -1)"
  echo "resolved_default_origin=$(printf '%s' "$resolved" | grep -c 'default' | awk '{print ($1>0) ? "present" : "missing"}')"
  echo "resolved_token_masked=$(printf '%s' "$resolved" | grep -o supersecret | head -1 | sed 's/supersecret/LEAKED/'; printf '%s' "$resolved" | grep -o '\*\*\*' | head -1)"

  # allowed_hosts from config takes effect on the daemon (needs restart).
  $cli config set allowed_hosts '*' >/dev/null </dev/null
  $cli workspace create "$yaml" --id cc6 >/dev/null </dev/null
  local open_code deny_code
  open_code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "http://127.0.0.1:$port/v1/health")"
  $cli daemon stop >/dev/null 2>&1 </dev/null || true
  sleep 1
  $cli config unset allowed_hosts >/dev/null </dev/null
  $cli workspace create "$yaml" --id cc7 >/dev/null </dev/null
  deny_code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "http://127.0.0.1:$port/v1/health")"
  echo "allowed_hosts_wildcard=$([ "$open_code" == "200" ] && echo open || echo "$open_code")"
  echo "allowed_hosts_default_denies=$([ "$deny_code" != "200" ] && echo denied || echo open)"

  # Auth keys: jwt_issuer is a config key; the raw jwt_pubkey is not.
  $cli config set jwt_issuer https://issuer >/dev/null </dev/null
  echo "jwt_issuer_set=exit$?"
  $cli config set jwt_pubkey INLINEKEY >/dev/null 2>&1 </dev/null
  echo "jwt_pubkey_set=exit$?"

  $cli daemon stop >/dev/null 2>&1 </dev/null || true
  sleep 1
  unset MIRAGE_HOME
  rm -rf "$home" "$work"
}

echo "===== probing Python CLI ====="
probe "$PY_CLI" py 9410 | sort > /tmp/cli-config-py.txt
echo "===== probing TypeScript CLI ====="
probe "$TS_CLI" ts 9420 | sort > /tmp/cli-config-ts.txt

echo
echo "===== Python results ====="
cat /tmp/cli-config-py.txt

echo
echo "===== language parity (py vs ts) ====="
if diff -u /tmp/cli-config-py.txt /tmp/cli-config-ts.txt; then
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
  got="$(grep -F "$key=" /tmp/cli-config-py.txt | head -1 | cut -d= -f2-)"
  if [ "$got" == "$want" ]; then
    echo "  OK   $key == $(printf '%q' "$want")"
  else
    echo "  FAIL $key: got $(printf '%q' "$got") expected $(printf '%q' "$want")"
    fail=1
  fi
}
expect "file_perms" "600"
expect "relocate_health" "ok"
expect "relocate_pid_custom" "exists"
expect "relocate_pid_default" "absent"
expect "relocate_readback" "hello"
expect "relocate_repo_custom" "exists"
expect "relocate_repo_default" "absent"
expect "relocate_log" "v1"
expect "snapshot_outside_root" "denied"
expect "relocate_snapshot_custom" "exists"
expect "relocate_snapshot_default" "absent"
expect "remove_new_repo" "exists"
expect "remove_old_untouched" "exists"
expect "remove_new_not_in_old" "clean"
expect "env_beats_config_effective" "yes"
expect "env_config_dir_untouched" "clean"
expect "set_get" "vroot2"
expect "unset_unknown_ok" "exit0"
expect "unknown_set" "exit2"
expect "unknown_set_msg" "unknown config key"
expect "unknown_set_msg_clean" "clean"
expect "typo_spawn" "exit2"
expect "typo_spawn_msg" "typo_key"
expect "typo_spawn_clean" "0"
expect "list_warns" "typo_key"
expect "repair_unset" "exit0"
expect "start_after_repair" "exit0"
expect "malformed_list" "exit2"
expect "malformed_msg" "malformed"
expect "resolved_env_origin" "env MIRAGE_SNAPSHOT_ROOT"
expect "resolved_file_value" "/file/repos"
expect "resolved_default_origin" "present"
expect "resolved_token_masked" "***"
expect "allowed_hosts_wildcard" "open"
expect "allowed_hosts_default_denies" "denied"
expect "jwt_issuer_set" "exit0"
expect "jwt_pubkey_set" "exit2"

if [ "$fail" != "0" ]; then
  echo
  echo "CLI config battery FAILED."
  exit 1
fi
echo
echo "CLI config battery OK (relocation, restart re-read, env precedence, validation, repair, resolved view; py == ts)."
