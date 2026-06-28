#!/usr/bin/env bash
# CLI end-to-end FUSE parity. Drives the daemon-backed CLI to create a workspace
# with TWO per-mount FUSE subtrees pinned to known OS paths plus ONE generated
# mount (fuse: true), writes content through the VFS, then reads it back THROUGH
# the kernel mountpoints. The daemon hosts the mounts in its own process, so the
# reading shell never deadlocks. Proves the CLI really mounts each subtree on
# both languages, and that close() cleanup is ownership-aware: caller-owned
# (pinned) mountpoint directories survive unmount, while generated temp
# directories are removed with an empty-dir rmdir.
# Requires libfuse + /dev/fuse, so it runs only in the fuse CI job.
#
# Usage: cli_fuse.sh "<py-cli>" "<ts-cli>"
set -uo pipefail

PY_CLI="${1:?python mirage cli command}"
TS_CLI="${2:?typescript mirage cli command}"
fail=0

points() { jq -r '.fuse_mountpoints // .fuseMountpoints'; }

# Run the full CLI battery against one CLI; emit one "key=value" line per probe.
probe() {
  local cli="$1" lang="$2"
  local dmnt="/tmp/cli-fuse-$lang-data"
  local lmnt="/tmp/cli-fuse-$lang-logs"
  fusermount -u "$dmnt" 2>/dev/null || umount "$dmnt" 2>/dev/null || true
  fusermount -u "$lmnt" 2>/dev/null || umount "$lmnt" 2>/dev/null || true
  rm -rf "$dmnt" "$lmnt"

  local yaml="/tmp/cli-fuse-$lang.yaml"
  cat > "$yaml" <<YML
mode: WRITE
mounts:
  /data:
    resource: ram
    fuse: $dmnt
  /logs:
    resource: ram
    fuse: $lmnt
  /auto:
    resource: ram
    fuse: true
YML

  $cli daemon stop >/dev/null 2>&1 </dev/null || true
  sleep 1

  # Collision rejection: two mounts whose fuse: resolves to the SAME OS path must
  # be rejected at workspace-create time (server returns 409, CLI exits non-zero),
  # and the server must not leak a partial mount. Self-contained sub-check that
  # never touches the main cf workspace.
  local collide_mp="/tmp/cli-fuse-$lang-collide-mp"
  local yaml_collide="/tmp/cli-fuse-$lang-collide.yaml"
  cat > "$yaml_collide" <<YML
mode: WRITE
mounts:
  /one:
    resource: ram
    fuse: $collide_mp
  /two:
    resource: ram
    fuse: $collide_mp
YML
  $cli workspace delete cfx >/dev/null 2>&1 </dev/null || true
  if $cli workspace create "$yaml_collide" --id cfx >/dev/null 2>&1 </dev/null; then
    echo "collision_rejected=no"
    $cli workspace delete cfx >/dev/null 2>&1 </dev/null || true
  else
    echo "collision_rejected=yes"
  fi

  $cli workspace delete cf >/dev/null 2>&1 </dev/null || true
  $cli workspace create "$yaml" --id cf >/dev/null </dev/null

  # RAM mounts start empty; seed through the VFS. The live workspace is what
  # FUSE serves, so these writes are immediately visible at the mountpoints.
  $cli execute -w cf -c 'echo alpha > /data/a.txt' </dev/null >/dev/null
  $cli execute -w cf -c 'echo beta > /logs/b.txt' </dev/null >/dev/null

  # The daemon mounts asynchronously; wait for both files to appear via the OS.
  local i
  for i in $(seq 1 50); do
    [ -f "$dmnt/a.txt" ] && [ -f "$lmnt/b.txt" ] && break
    sleep 0.2
  done

  local detail data_mp logs_mp auto_mp
  detail="$($cli workspace get cf </dev/null)"
  data_mp="$(printf '%s' "$detail" | points | jq -r '."/data" // empty')"
  logs_mp="$(printf '%s' "$detail" | points | jq -r '."/logs" // empty')"
  auto_mp="$(printf '%s' "$detail" | points | jq -r '."/auto" // empty')"

  # The generated mount got a temp mountpoint Mirage picked; exercise it through
  # the kernel the same way as the pinned mounts.
  $cli execute -w cf -c 'echo gamma > /auto/c.txt' </dev/null >/dev/null
  for i in $(seq 1 50); do
    [ -n "$auto_mp" ] && [ -f "$auto_mp/c.txt" ] && break
    sleep 0.2
  done

  echo "data_cat=$(cat "$dmnt/a.txt" 2>/dev/null)"
  echo "logs_cat=$(cat "$lmnt/b.txt" 2>/dev/null)"
  echo "auto_cat=$(cat "$auto_mp/c.txt" 2>/dev/null)"
  echo "logs_size=$(wc -c < "$lmnt/b.txt" 2>/dev/null | tr -d ' ')"
  echo "mount_keys=$(printf '%s' "$detail" | points | jq -r 'keys | sort | join(",")')"
  echo "data_pinned=$([ "$data_mp" == "$dmnt" ] && echo yes || echo no)"
  echo "logs_pinned=$([ "$logs_mp" == "$lmnt" ] && echo yes || echo no)"
  echo "auto_generated=$([ -n "$auto_mp" ] && [ "$auto_mp" != "$dmnt" ] && [ "$auto_mp" != "$lmnt" ] && echo yes || echo no)"
  echo "distinct=$([ -n "$data_mp" ] && [ "$data_mp" != "$logs_mp" ] && echo yes || echo no)"

  # Deleting the workspace runs the daemon-side close() for every mount. Cleanup
  # must keep caller-owned (pinned) directories and remove only the generated
  # temp directory. Wait for the generated dir to disappear, then assert.
  $cli workspace delete cf >/dev/null 2>&1 </dev/null || true
  for i in $(seq 1 25); do
    [ -n "$auto_mp" ] && [ ! -d "$auto_mp" ] && break
    sleep 0.2
  done
  echo "data_dir_survives=$([ -d "$dmnt" ] && echo yes || echo no)"
  echo "logs_dir_survives=$([ -d "$lmnt" ] && echo yes || echo no)"
  echo "gen_dir_removed=$([ -n "$auto_mp" ] && [ ! -d "$auto_mp" ] && echo yes || echo no)"

  # Reuse a pinned mountpoint across re-create: the caller-owned $dmnt directory
  # survived the cf delete above, so a NEW workspace pinned to the SAME path must
  # mount fine and serve a file through the kernel.
  local reuse_yaml="/tmp/cli-fuse-$lang-reuse.yaml"
  cat > "$reuse_yaml" <<YML
mode: WRITE
mounts:
  /data:
    resource: ram
    fuse: $dmnt
YML
  $cli workspace delete cf2 >/dev/null 2>&1 </dev/null || true
  $cli workspace create "$reuse_yaml" --id cf2 >/dev/null </dev/null
  $cli execute -w cf2 -c 'echo reused > /data/r.txt' </dev/null >/dev/null
  for i in $(seq 1 50); do
    [ -f "$dmnt/r.txt" ] && break
    sleep 0.2
  done
  echo "reuse_after_recreate=$(cat "$dmnt/r.txt" 2>/dev/null)"
  $cli workspace delete cf2 >/dev/null 2>&1 </dev/null || true

  $cli daemon stop >/dev/null 2>&1 </dev/null || true
  fusermount -u "$dmnt" 2>/dev/null || umount "$dmnt" 2>/dev/null || true
  fusermount -u "$lmnt" 2>/dev/null || umount "$lmnt" 2>/dev/null || true
  [ -n "$auto_mp" ] && { fusermount -u "$auto_mp" 2>/dev/null || umount "$auto_mp" 2>/dev/null || true; }
  fusermount -u "$collide_mp" 2>/dev/null || umount "$collide_mp" 2>/dev/null || true
  rm -rf "$dmnt" "$lmnt" "$collide_mp" "$yaml_collide" "$reuse_yaml" ${auto_mp:+"$auto_mp"}
}

echo "===== probing Python CLI ====="
probe "$PY_CLI" py | sort > /tmp/cli-fuse-py.txt
echo "===== probing TypeScript CLI ====="
probe "$TS_CLI" ts | sort > /tmp/cli-fuse-ts.txt

echo
echo "===== Python results ====="
cat /tmp/cli-fuse-py.txt

echo
echo "===== language parity (py vs ts) ====="
if diff -u /tmp/cli-fuse-py.txt /tmp/cli-fuse-ts.txt; then
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
  got="$(grep -F "$key=" /tmp/cli-fuse-py.txt | head -1 | cut -d= -f2-)"
  if [ "$got" == "$want" ]; then
    echo "  OK   $key == $(printf '%q' "$want")"
  else
    echo "  FAIL $key: got $(printf '%q' "$got") expected $(printf '%q' "$want")"
    fail=1
  fi
}
expect "data_cat" "alpha"
expect "logs_cat" "beta"
expect "auto_cat" "gamma"
expect "logs_size" "5"
expect "mount_keys" "/auto,/data,/logs"
expect "data_pinned" "yes"
expect "logs_pinned" "yes"
expect "auto_generated" "yes"
expect "distinct" "yes"
expect "data_dir_survives" "yes"
expect "logs_dir_survives" "yes"
expect "gen_dir_removed" "yes"
expect "collision_rejected" "yes"
expect "reuse_after_recreate" "reused"

if [ "$fail" != "0" ]; then
  echo
  if [ -f "$HOME/.mirage/daemon.log" ]; then
    echo "===== ~/.mirage/daemon.log (last 60 lines) ====="
    tail -60 "$HOME/.mirage/daemon.log"
    echo
  fi
  echo "CLI FUSE parity FAILED."
  exit 1
fi
echo
echo "CLI FUSE parity OK (two pinned + one generated FUSE subtree read through the kernel; ownership-aware cleanup; py == ts)."
