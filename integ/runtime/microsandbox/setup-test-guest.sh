#!/usr/bin/env bash
set -euo pipefail

# Provision only a dedicated, running test guest; this does not create or remove it.
sandbox="${1:?usage: setup-test-guest.sh SANDBOX MIRAGE_WHEEL}"
wheel="${2:?usage: setup-test-guest.sh SANDBOX MIRAGE_WHEEL}"
test -f "$wheel"
test_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
wheel_name="$(basename "$wheel")"

msb copy --quiet "$wheel" "$sandbox:/tmp/$wheel_name"
msb copy --quiet "$test_dir/guest_ops.py" "$sandbox:/tmp/mirage_e2e_ops.py"
msb copy --quiet "$test_dir/guest.yaml" "$sandbox:/tmp/mirage-e2e.yaml"
msb exec "$sandbox" --quiet --no-tty -w / -e "MIRAGE_E2E_WHEEL=/tmp/$wheel_name" -- sh -eu -c '
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sshfs fuse3 libfuse2 procps
  mkdir -p /tmp/e2e-ro /data /e2e-guest /boxdata
  python3 -m pip install -q "${MIRAGE_E2E_WHEEL}[fuse]"
  printf "locked\n" > /tmp/e2e-ro/protected.txt
  mountpoint -q /boxdata || mount -t tmpfs tmpfs /boxdata
  printf "box\n" > /boxdata/own.txt
  mirage workspace create /tmp/mirage-e2e.yaml --id e2e
  mirage shell -w e2e -c "echo seed > /e2e-guest/seed.txt; echo secret > /e2e-guest/secret.txt; echo '\''hello from Mirage FUSE'\'' > /data/hello.txt"
  test -c /dev/fuse
  mountpoint -q /e2e-guest
  mountpoint -q /data
'
