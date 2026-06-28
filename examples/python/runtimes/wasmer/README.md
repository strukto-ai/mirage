# Wasmer + Mirage FUSE

Run an untrusted [Wasmer](https://wasmer.io) (WASM/WASIX) sandbox that reads S3
through a host-side Mirage FUSE mount. The guest sees a normal `/s3` directory
and never touches S3 credentials or the network.

## How it works

```
WASIX Python guest  --mapdir /s3-->  host FUSE mountpoint  -->  Mirage  -->  S3
   (wasmer run)                         (macFUSE / fuse3)
```

1. `wasmer_fuse.py` (host) FUSE-mounts an `S3Resource` at a temp mountpoint.
1. It launches `wasmer run python/python` with `--mapdir /s3:<mountpoint>`, so the
   guest's `/s3` is backed by the host FUSE mount.
1. `remote/guest.py` runs inside the WASIX guest: it `os.listdir('/s3')` and reads
   `/s3/data/example.jsonl` as if they were local files.

Mirage stays on the host because the Python `wasmer` binding is frozen at 3.10;
we drive the actively-maintained `wasmer` CLI as a subprocess instead.

## Prerequisites

- **`wasmer` CLI** on `PATH`: install from <https://wasmer.io> (`curl https://get.wasmer.io -sSfL | sh`).
- **Host FUSE**: macOS [macFUSE](https://macfuse.github.io/), or Linux `fuse3`.
- **AWS credentials** in `.env.development` at the repo root:
  `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optionally
  `AWS_DEFAULT_REGION`.
- The bucket must contain `data/example.jsonl` (any text/JSONL file works; the
  guest just counts lines containing `mirage`).

## Run

From the repo root (so `.env.development` loads):

```bash
./python/.venv/bin/python examples/python/runtimes/wasmer/wasmer_fuse.py
```

Expected tail:

```
=== guest output ===
--- os.listdir('/s3') ---
  data
  ...
--- read /s3/data/example.jsonl through Wasmer -> FUSE -> Mirage -> S3 ---
  5766 lines, 5678 containing 'mirage'

Mirage served 104 ops, 10432116 bytes to the sandbox
```

## First-run note

The very first `wasmer run python/python` downloads the WASIX Python package from
the Wasmer registry, which can take a few minutes. The example's subprocess
timeout (180s) may fire during that cold download and surface as a
`TimeoutExpired` traceback. Warm the cache once, then re-run:

```bash
wasmer run python/python -- -c "print('warm')"
```

## Platform support

Works on both **macOS** (macFUSE) and **Linux** (fuse3). Not run in CI. It
needs the `wasmer` CLI, host FUSE, and live AWS credentials.
