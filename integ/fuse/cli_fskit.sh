#!/usr/bin/env bash
# CLI end-to-end fskit. Drives the daemon-backed CLI to create a workspace with
# ONE fskit mount (macOS allows one FUSE mount per process, and the daemon
# hosts the mount), writes through the VFS, then reads AND writes through the
# kernel mountpoint under /Volumes. Proves the CLI config path really reaches
# Apple's FSKit: the mount row is tagged fskit, stat size equals read size
# (fskit clamps reads to the lookup-time size, so these agreeing is what
# SIZES_ALWAYS_KNOWN guarantees), the metadata write surface works, and two
# measured shim limits stay pinned:
#   - new-content zeroing: pages for regions a file did not already have
#     (new file, empty file, truncate-then-write) flush as NUL bytes of the
#     right length, and even appended regions arrive intact or zeroed
#     depending on cache state, so data writes over fskit are unreliable
#     (check_writes warns about this at mount time). The writer sees no
#     error, which is exactly why this went unnoticed. macFUSE FSKit shim
#     bug; when a macFUSE release fixes it, the pinned expectation flips
#     and this test says so.
#   - TypeScript cannot create new names over fskit: the shim finalizes new
#     items via macFUSE's Darwin-only setattr_x/renamex callbacks, which
#     fuse-native's compiled op table cannot gain from JS. Python installs
#     them at runtime and has the metadata surface.
#
# macOS + macFUSE 5.x only. On a host that cannot engage the FSKit module
# (hosted CI runners), the mount never becomes ready and the script reports
# SKIP with exit 0, mirroring the integ-fskit job's classification: red means
# something structurally new broke, green means verified or environment-limited.
#
# Usage: cli_fskit.sh "<py-cli>" ["<ts-cli>"]
set -uo pipefail

PY_CLI="${1:?python mirage cli command}"
TS_CLI="${2:-}"
fail=0

if [ "$(uname)" != "Darwin" ]; then
  echo "SKIP: fskit is macOS-only"
  exit 0
fi

points() { jq -r '.fuse_mountpoints // .fuseMountpoints'; }

mount_row() { mount | grep -F "$1" | head -1; }

vfs_out() {
  local cli="$1" cmd="$2"
  $cli execute -w cfk -c "$cmd" </dev/null 2>/dev/null | jq -r '.stdout' | tr '\n' '|'
}

# Run the battery against one CLI; emit one "key=value" line per probe.
# Emits "skip_not_ready=yes" instead when the mount never engages.
probe() {
  local cli="$1" lang="$2"
  local yaml="/tmp/cli-fskit-$lang.yaml"
  cat > "$yaml" <<YML
mode: WRITE
mounts:
  /data:
    resource: ram
    backend: fskit
YML

  $cli daemon stop >/dev/null 2>&1 </dev/null || true
  sleep 1
  $cli workspace delete cfk >/dev/null 2>&1 </dev/null || true
  $cli workspace create "$yaml" --id cfk >/dev/null </dev/null

  # RAM mounts start empty; seed through the VFS. The daemon serves the live
  # workspace, so the write is immediately visible at the kernel mountpoint.
  $cli execute -w cfk -c 'printf "{\"messages\": 2}\n" > /data/api.json' </dev/null >/dev/null
  $cli execute -w cfk -c 'printf "old\n" > /data/existing.txt' </dev/null >/dev/null

  local detail mp i
  detail="$($cli workspace get cfk </dev/null)"
  mp="$(printf '%s' "$detail" | points | jq -r '."/data" // empty')"

  # The daemon mounts asynchronously; wait for the seeded file via the OS.
  for i in $(seq 1 75); do
    [ -n "$mp" ] && [ -f "$mp/api.json" ] && break
    sleep 0.2
  done

  if [ -z "$mp" ] || [ ! -f "$mp/api.json" ]; then
    # The known cannot-engage-FSKit signature: the readiness timeout in the
    # daemon log. Anything else is a real failure.
    if tail -200 "$HOME/.mirage/daemon.log" 2>/dev/null | grep -q "did not become ready"; then
      echo "skip_not_ready=yes"
    else
      echo "mount_ready=no"
    fi
    $cli workspace delete cfk >/dev/null 2>&1 </dev/null || true
    $cli daemon stop >/dev/null 2>&1 </dev/null || true
    return
  fi

  if [[ "$mp" == /Volumes/* ]]; then
    echo "under_volumes=yes"
  else
    echo "under_volumes=no"
  fi
  echo "tagged_fskit=$(mount_row "$mp" | grep -q fskit && echo yes || echo no)"
  echo "cat=$(cat "$mp/api.json" 2>/dev/null | tr -d '\n')"
  # fskit clamps every read to the size stat reported at lookup, so the stat
  # size and the read byte count agreeing is the whole ballgame.
  echo "stat_size=$(stat -f %z "$mp/api.json" 2>/dev/null)"
  echo "read_size=$(wc -c < "$mp/api.json" 2>/dev/null | tr -d ' ')"

  # The append syscall succeeds; whether the data survives the shim's flush
  # is nondeterministic (measured: intact or zeroed depending on cache
  # state), so only the op result is pinned, not the persisted bytes.
  echo "append=$(printf 'more\n' >> "$mp/existing.txt" 2>/dev/null && echo ok || echo fail)"

  # The metadata write surface through the kernel (setattr_x/renamex path).
  echo "create=$(touch "$mp/new.txt" 2>/dev/null && echo ok || echo fail)"
  echo "mkdir=$(mkdir "$mp/sub" 2>/dev/null && echo ok || echo fail)"
  echo "rename=$(mv "$mp/api.json" "$mp/moved.json" 2>/dev/null && echo ok || echo fail)"
  echo "unlink=$(rm "$mp/existing.txt" 2>/dev/null && echo ok || echo fail)"

  # New-content zeroing, pinned. The writer sees no error; the store
  # receives NUL bytes of the right length (macFUSE FSKit shim bug).
  if [ -f "$mp/new.txt" ]; then
    printf 'fresh\n' > "$mp/new.txt" 2>/dev/null
    sync
    local hexed=""
    for i in $(seq 1 25); do
      hexed="$(vfs_out "$cli" 'xxd -p /data/new.txt')"
      [ "$hexed" == "000000000000||" ] && break
      sleep 0.2
    done
    echo "new_file_store_hex=$hexed"
  fi

  # Deleting the workspace unmounts; the system removes the /Volumes entry.
  $cli workspace delete cfk >/dev/null 2>&1 </dev/null || true
  for i in $(seq 1 50); do
    [ -z "$(mount_row "$mp")" ] && break
    sleep 0.2
  done
  echo "unmounted=$([ -z "$(mount_row "$mp")" ] && echo yes || echo no)"

  $cli daemon stop >/dev/null 2>&1 </dev/null || true
  rm -f "$yaml"
}

check() {
  local file="$1" key="$2" want="$3"
  local got
  got="$(grep -F "$key=" "$file" | head -1 | cut -d= -f2-)"
  if [ "$got" == "$want" ]; then
    echo "  OK   $key == $(printf '%q' "$want")"
  else
    echo "  FAIL $key: got $(printf '%q' "$got") expected $(printf '%q' "$want")"
    fail=1
  fi
}

echo "===== probing Python CLI ====="
probe "$PY_CLI" py | sort > /tmp/cli-fskit-py.txt
cat /tmp/cli-fskit-py.txt

if grep -q "skip_not_ready=yes" /tmp/cli-fskit-py.txt; then
  echo "SKIP: this host cannot engage the macFUSE FSKit module" \
       "(known hosted-runner limit; verified locally instead)"
  exit 0
fi

echo
echo "===== expected values (python) ====="
check /tmp/cli-fskit-py.txt "under_volumes" "yes"
check /tmp/cli-fskit-py.txt "tagged_fskit" "yes"
check /tmp/cli-fskit-py.txt "cat" '{"messages": 2}'
check /tmp/cli-fskit-py.txt "stat_size" "16"
check /tmp/cli-fskit-py.txt "read_size" "16"
check /tmp/cli-fskit-py.txt "append" "ok"
check /tmp/cli-fskit-py.txt "create" "ok"
check /tmp/cli-fskit-py.txt "mkdir" "ok"
check /tmp/cli-fskit-py.txt "rename" "ok"
check /tmp/cli-fskit-py.txt "unlink" "ok"
check /tmp/cli-fskit-py.txt "new_file_store_hex" "000000000000||"
check /tmp/cli-fskit-py.txt "unmounted" "yes"

if [ -n "$TS_CLI" ]; then
  echo
  echo "===== probing TypeScript CLI ====="
  probe "$TS_CLI" ts | sort > /tmp/cli-fskit-ts.txt
  cat /tmp/cli-fskit-ts.txt
  echo
  echo "===== expected values (typescript) ====="
  check /tmp/cli-fskit-ts.txt "under_volumes" "yes"
  check /tmp/cli-fskit-ts.txt "tagged_fskit" "yes"
  check /tmp/cli-fskit-ts.txt "cat" '{"messages": 2}'
  check /tmp/cli-fskit-ts.txt "stat_size" "16"
  check /tmp/cli-fskit-ts.txt "read_size" "16"
  check /tmp/cli-fskit-ts.txt "append" "ok"
  # fuse-native's compiled op table cannot gain the Darwin-only
  # setattr_x/renamex callbacks, so creating new names fails from JS.
  check /tmp/cli-fskit-ts.txt "create" "fail"
  check /tmp/cli-fskit-ts.txt "mkdir" "fail"
  check /tmp/cli-fskit-ts.txt "rename" "fail"
  check /tmp/cli-fskit-ts.txt "unlink" "ok"
  check /tmp/cli-fskit-ts.txt "unmounted" "yes"
fi

if [ "$fail" != "0" ]; then
  echo
  if [ -f "$HOME/.mirage/daemon.log" ]; then
    echo "===== ~/.mirage/daemon.log (last 60 lines) ====="
    tail -60 "$HOME/.mirage/daemon.log"
    echo
  fi
  echo "CLI fskit FAILED."
  exit 1
fi
echo
echo "CLI fskit OK (workspace YAML backend: fskit mounted through Apple's FSKit; kernel reads exact, metadata writes work, known shim limits pinned)."
