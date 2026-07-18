#!/usr/bin/env bash
# CLI config battery. Part A proves MIRAGE_HOME is the single data root
# (Docker data-root semantics): with the home relocated, the real
# workspace workload (create, execute, commit, log, snapshot, readback)
# runs fine and every artifact (pid file, git repos, snapshots, config,
# state) physically lands under it, with snapshots outside it refused.
# It then moves the daemon port through `mirage config set` and restarts
# to prove settings are re-read at startup, and proves env beats config
# via allowed_hosts. Part B covers the command surface: 0600 perms,
# unknown-key rejection with a clean message, a typo key making the
# daemon refuse to start until repaired with `config unset`, malformed
# TOML failing cleanly, resolved-view origins with auth_token masked,
# and allowed_hosts/jwt key handling.
#
# Usage: cli_config.sh "<py-cli>" "<ts-cli>"
set -uo pipefail

PY_CLI="${1:?python mirage cli command}"
TS_CLI="${2:?typescript mirage cli command}"
fail=0

probe() {
  local cli="$1" lang="$2" port="$3"
  local port2=$((port + 1))
  local home work
  home="$(mktemp -d "/tmp/cli-config-$lang-home.XXXXXX")"
  work="$(mktemp -d "/tmp/cli-config-$lang-work.XXXXXX")"
  export MIRAGE_HOME="$home"
  unset MIRAGE_DAEMON_PORT MIRAGE_DAEMON_URL MIRAGE_ALLOWED_HOSTS \
    MIRAGE_AUTH_MODE 2>/dev/null || true

  local yaml="$work/ram.yaml"
  cat > "$yaml" <<YML
mode: WRITE
mounts:
  /data:
    resource: ram
YML

  # --- Part A: the home is the single root; run the real workload ---
  $cli config set port "$port" >/dev/null </dev/null
  $cli config set url "http://127.0.0.1:$port" >/dev/null </dev/null
  echo "file_perms=$(stat -c '%a' "$home/config.toml" 2>/dev/null || stat -f '%Lp' "$home/config.toml")"

  $cli workspace delete cc >/dev/null 2>&1 </dev/null || true
  $cli workspace create "$yaml" --id cc >/dev/null </dev/null
  local health
  health="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/v1/health")"
  echo "home_health=$([ "$health" == "200" ] && echo ok || echo "$health")"
  echo "home_pid=$([ -s "$home/daemon.pid" ] && echo exists || echo absent)"

  $cli execute -w cc -c 'echo hello > /data/f.txt' </dev/null >/dev/null
  echo "home_readback=$($cli execute -w cc -c 'cat /data/f.txt' </dev/null | tail -c 200 | grep -o hello | head -1)"
  $cli workspace commit cc -m v1 >/dev/null </dev/null
  echo "home_repo=$([ -d "$home/repos/cc/objects" ] && echo exists || echo absent)"
  echo "home_log=$($cli workspace log cc </dev/null | grep -o v1 | head -1)"

  # Snapshots must land inside $home/snapshots: a target outside it is
  # refused, a target under it is written there.
  if $cli workspace snapshot cc "$work/outside.tar" >/dev/null 2>&1 </dev/null; then
    echo "snapshot_outside_root=allowed"
  else
    echo "snapshot_outside_root=denied"
  fi
  mkdir -p "$home/snapshots"
  $cli workspace snapshot cc "$home/snapshots/out.tar" >/dev/null </dev/null
  echo "home_snapshot=$([ -s "$home/snapshots/out.tar" ] && echo exists || echo absent)"

  # --- settings are re-read on restart: move the port ---
  $cli daemon stop >/dev/null 2>&1 </dev/null || true
  sleep 1
  $cli config set port "$port2" >/dev/null </dev/null
  $cli config set url "http://127.0.0.1:$port2" >/dev/null </dev/null
  $cli workspace create "$yaml" --id cc2 >/dev/null </dev/null
  health="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port2/v1/health")"
  echo "reread_health=$([ "$health" == "200" ] && echo ok || echo "$health")"

  # --- env beats config, proven by the Host-header allowlist ---
  $cli daemon stop >/dev/null 2>&1 </dev/null || true
  sleep 1
  $cli config set allowed_hosts '127.0.0.1,localhost,::1' >/dev/null </dev/null
  MIRAGE_ALLOWED_HOSTS='*' $cli workspace create "$yaml" --id cc3 >/dev/null </dev/null
  local env_code
  env_code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "http://127.0.0.1:$port2/v1/health")"
  echo "env_beats_config=$([ "$env_code" == "200" ] && echo open || echo "$env_code")"
  $cli daemon stop >/dev/null 2>&1 </dev/null || true
  sleep 1
  $cli config unset allowed_hosts >/dev/null </dev/null

  # --- Part B: command surface ---
  echo "set_get=$($cli config get port </dev/null | tr -d '"{}: ' | grep -q "$port2" && echo moved || echo missing)"
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
  $cli config set port "$port2" >/dev/null </dev/null
  $cli config set url "http://127.0.0.1:$port2" >/dev/null </dev/null

  # Resolved view: origins for env / file / default, auth_token masked.
  $cli config set jwt_issuer https://file-issuer >/dev/null </dev/null
  local resolved
  resolved="$(MIRAGE_IDLE_GRACE_SECONDS=77 MIRAGE_TOKEN=supersecret $cli config list --resolved </dev/null)"
  echo "resolved_env_origin=$(printf '%s' "$resolved" | grep -o 'env MIRAGE_IDLE_GRACE_SECONDS' | head -1)"
  echo "resolved_file_value=$(printf '%s' "$resolved" | grep -o 'file-issuer' | head -1)"
  echo "resolved_default_origin=$(printf '%s' "$resolved" | grep -c 'default' | awk '{print ($1>0) ? "present" : "missing"}')"
  echo "resolved_token_masked=$(printf '%s' "$resolved" | grep -o supersecret | head -1 | sed 's/supersecret/LEAKED/'; printf '%s' "$resolved" | grep -o '\*\*\*' | head -1)"
  $cli config unset jwt_issuer >/dev/null </dev/null

  # allowed_hosts from config takes effect on the daemon (needs restart).
  $cli config set allowed_hosts '*' >/dev/null </dev/null
  $cli workspace create "$yaml" --id cc6 >/dev/null </dev/null
  local open_code deny_code
  open_code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "http://127.0.0.1:$port2/v1/health")"
  $cli daemon stop >/dev/null 2>&1 </dev/null || true
  sleep 1
  $cli config unset allowed_hosts >/dev/null </dev/null
  $cli workspace create "$yaml" --id cc7 >/dev/null </dev/null
  deny_code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "http://127.0.0.1:$port2/v1/health")"
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
expect "home_health" "ok"
expect "home_pid" "exists"
expect "home_readback" "hello"
expect "home_repo" "exists"
expect "home_log" "v1"
expect "snapshot_outside_root" "denied"
expect "home_snapshot" "exists"
expect "reread_health" "ok"
expect "env_beats_config" "open"
expect "set_get" "moved"
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
expect "resolved_env_origin" "env MIRAGE_IDLE_GRACE_SECONDS"
expect "resolved_file_value" "file-issuer"
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
echo "CLI config battery OK (single-root home, restart re-read, env precedence, validation, repair, resolved view; py == ts)."
