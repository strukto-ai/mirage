# Microsandbox + Mirage FUSE

Run an untrusted [Microsandbox](https://microsandbox.dev) microVM that reads S3
through a host-side Mirage FUSE mount. Mirage FUSE-mounts S3 on the **host**;
Microsandbox bind-mounts that path into the microVM over virtio-fs. The guest
reads `/s3` natively, with no S3 credentials and no network of its own.

## How it works

```
microVM guest  --virtio-fs /s3-->  host FUSE mountpoint  -->  Mirage  -->  S3
 (msb / libkrun)                       (fuse3)
```

1. `microsandbox_fuse.py` (host) FUSE-mounts an `S3Resource` at a temp mountpoint.
1. It boots a microVM with `Volume.bind(<mountpoint>, readonly=True)` mapped to
   `/s3`, so the guest's `/s3` is backed by the host FUSE mount over virtio-fs.
1. `remote/guest.py` runs inside the microVM: it `os.listdir('/s3')` and reads
   `/s3/data/example.jsonl` as if they were local files.

The microVM guest has no `/dev/fuse`, so Mirage can't run in the guest; the host
mount is shared in instead.

## Prerequisites

- **Microsandbox Python SDK**: `uv pip install microsandbox` (tested with 0.5.10).
- **`msb` runtime** (provides libkrunfw): `curl -sSfL https://get.microsandbox.dev | sh`.
  On Apple Silicon this also pulls the libkrun HVF backend; x86_64 macOS is not
  supported by Microsandbox.
- **Host FUSE**: Linux `fuse3` (see platform note below for macOS).
- **AWS credentials** in `.env.development` at the repo root:
  `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optionally
  `AWS_DEFAULT_REGION`.
- The bucket must contain `data/example.jsonl` (any text/JSONL file works; the
  guest just counts lines containing `mirage`).

The SDK 0.5.10 embeds the runtime in-process, so there is **no separate `msb server` to start** (just run the example).

## Run

From the repo root (so `.env.development` loads):

```bash
./python/.venv/bin/python examples/python/microsandbox/microsandbox_fuse.py
```

Expected tail:

```
=== guest output ===
--- os.listdir('/s3') ---
  data
  ...
--- read /s3/data/example.jsonl through virtio-fs -> FUSE -> Mirage -> S3 ---
  5766 lines, 5678 containing 'mirage'

Mirage served N ops, ... bytes to the sandbox
```

## Platform note: Linux only

This example runs on **Linux**. On **macOS it does not work**: libkrun's virtio-fs
cannot re-export a macFUSE-backed directory into the microVM. Booting the VM
fails at the bind-mount with:

```
failed to start "mirage-fuse": mount s3_<hash>: Operation not permitted (os error 1)
```

This is a libkrun + macFUSE interaction, not a Mirage or Microsandbox bug:

- It reproduces with both S3-backed and RAM-backed FUSE mounts (the trigger is the
  macFUSE filesystem type, not the backend).
- A plain (non-FUSE) host directory bind-mounts and reads fine inside the same
  microVM, so virtio-fs itself works on macOS.
- Mounting the FUSE filesystem with `allow_other` does not help; the failure is
  `EPERM` (not `EACCES`), from a macOS-specific VFS operation libkrun's host-side
  virtio-fs server issues during share setup that macFUSE rejects.

On macOS, use the sibling [`wasmer`](../wasmer/README.md) example instead: it maps
the same host FUSE mount into a WASIX guest with `--mapdir` and works on macOS.

Not run in CI. It needs the Microsandbox runtime, host FUSE, and live AWS
credentials.
