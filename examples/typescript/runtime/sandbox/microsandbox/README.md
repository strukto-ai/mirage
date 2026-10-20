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

1. `microsandbox_fuse.ts` (host) FUSE-mounts an `S3VFS` at a temp mountpoint.
1. It boots a microVM with `msb run --volume <mountpoint>:/s3:ro`, so the
   guest's `/s3` is backed by the host FUSE mount over virtio-fs.
1. The guest script runs inside the microVM: it `os.listdir('/s3')` and reads
   `/s3/data/example.jsonl` as if they were local files. It is the Python
   example's
   [`remote/guest.py`](../../../../python/runtime/sandbox/microsandbox/remote/guest.py),
   mapped in read-only at `/prog`.

The microVM guest has no `/dev/fuse`, so Mirage can't run in the guest; the host
mount is shared in instead.

`msb run` runs as an async child process, as it does in Mirage's
`MicrosandboxRuntime`. The FUSE mount is served by this process's event loop, so
the loop must stay free while the guest reads through it.

## Prerequisites

- **`msb` CLI** on `PATH` (provides libkrunfw):
  `curl -sSfL https://get.microsandbox.dev | sh` (tested with 0.5.10). On Apple
  Silicon this also pulls the libkrun HVF backend; x86_64 macOS is not
  supported by Microsandbox.
- **Host FUSE**: Linux `fuse3` (see platform note below for macOS), and
  `@zkochan/fuse-native`, already a dev dependency of these examples.
- **AWS credentials** in `.env.development` at the repo root:
  `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optionally
  `AWS_DEFAULT_REGION`.
- The bucket must contain `data/example.jsonl` (any text/JSONL file works; the
  guest just counts lines containing `mirage`).

There is **no separate `msb server` to start** (just run the example).

## Run

From `examples/typescript`:

```bash
pnpm exec tsx runtime/sandbox/microsandbox/microsandbox_fuse.ts
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

This is a libkrun + macFUSE interaction, not a Mirage or Microsandbox bug; the
[Python example's README](../../../../python/runtime/sandbox/microsandbox/README.md#platform-note-linux-only)
has the details.

Not run in CI. It needs the Microsandbox runtime, host FUSE, and live AWS
credentials.
