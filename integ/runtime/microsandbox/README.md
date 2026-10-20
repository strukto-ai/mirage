# microsandbox tests

Tests `fuse`, `ssh` and `both` against a real guest. This setup is only for
integration tests, not normal Mirage usage.

Use a disposable guest: the tests restart it and temporarily disable
`/dev/fuse`.

## Prepare

Install the released `msb` CLI and build the Node packages. The guest
needs a Linux wheel for its own architecture, which maturin's container
builds for the Docker host's. From the repo root:

```bash
mkdir -p /tmp/mirage-wheels
docker run --rm -v "$PWD:/io" -v /tmp/mirage-wheels:/out -e CARGO_TARGET_DIR=/tmp/target \
  -w /io/python ghcr.io/pyo3/maturin:v1.15.0 build --release --locked --out /out
msb create python:3.12-slim-bookworm --name mirage-e2e --memory 1G
bash integ/runtime/microsandbox/setup-test-guest.sh mirage-e2e /tmp/mirage-wheels/mirage_ai-*.whl
```

## Run

Run either command:

```bash
# Python
MIRAGE_E2E_SANDBOX=mirage-e2e python/.venv/bin/python integ/runtime/microsandbox/live.py

# TypeScript
MIRAGE_E2E_SANDBOX=mirage-e2e integ/node_modules/.bin/tsx integ/runtime/microsandbox/live.ts
```

Rerun the setup script before another test run to restore the guest's mounts.

Remove the guest when finished:

```bash
msb remove --force mirage-e2e
```

## SDK tests

The [Python tests](../../../python/tests/runtime/sandbox/microsandbox/) and
[TypeScript tests](../../../typescript/packages/node/src/runtime/sandbox/microsandbox/)
use these variables; unset variables skip the corresponding tests:

- `MIRAGE_INTEG_MICROSANDBOX_SANDBOX`: running guest with `python3` and a
  guest-owned FUSE mount at `/data`; `hello.txt` must contain
  `hello from Mirage FUSE` followed by a newline.
- `MIRAGE_INTEG_MICROSANDBOX_MOUNT_SANDBOX`: running guest with `python3`,
  `sshfs` and a usable `/dev/fuse`.
- `MIRAGE_INTEG_MICROSANDBOX_STOPPED_SANDBOX`: a stopped guest.
