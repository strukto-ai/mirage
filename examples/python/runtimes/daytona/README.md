# Daytona runtime + Mirage FUSE

Run whole `python3` lines inside a [Daytona](https://www.daytona.io) cloud
sandbox, with an S3 bucket mounted live inside the sandbox. Mirage runs **in the
sandbox** and FUSE-mounts S3 there, so the job reads and writes `/data/...` as
local files and every write streams straight back to the bucket, no sync step.

Unlike the [`microsandbox`](../microsandbox/README.md) and
[`wasmer`](../wasmer/README.md) examples (which share a **host** FUSE mount into
a guest), here the guest has its own `/dev/fuse` and runs Mirage itself.

## How it works

```
your machine (control plane)                 Daytona sandbox (yours)
  Workspace: /data -> S3Resource               provisioned by you:
  captures ["python3"] -> DaytonaRuntime  -->    mirage workspace create sandbox.yaml
  vfs runs every other line locally              -> FUSE-mounts S3 at /data
  cd /data; python3 train.py  ------------>    cwd passes through; train.py reads /data
```

1. The workspace declares `/data` as an `S3Resource`. A `DaytonaRuntime` captures
   `python3` lines; everything else stays on the local vfs.
1. Mirage never creates, provisions, or deletes sandboxes: you create one
   (below), provision the workspace inside it (`create_sandbox.py` does both:
   it uploads a sandbox-side config with the same mount at the same prefix and
   runs `mirage workspace create` in the sandbox), and hand the runtime its
   `sandbox_id`. Mirage only connects and execs lines.
1. The sandbox serves the same prefixes as the host, so the line, its cwd, and
   every path pass through verbatim: `/data` means the same thing on both
   sides, relative or absolute.

## Prerequisites

- **Daytona SDK**: installed with `mirage-ai[daytona]` (`uv sync` in `python/`
  already pulls it via the example extras).
- **`DAYTONA_API_KEY`** in `.env.development` at the repo root. Building the
  snapshot (below) also needs snapshot-write scope on the key.
- **AWS credentials** in `.env.development`: `AWS_S3_BUCKET`,
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optionally
  `AWS_DEFAULT_REGION`. The bucket is reachable from Daytona's cloud.
- A stock Daytona sandbox already ships `/dev/fuse` and `fusermount3`, so no
  privileged flags are needed. It does **not** ship Mirage, so the sandbox needs
  an image or snapshot with `fuse3` and `mirage-ai[s3,fuse]` baked in.

## One-time: bake the FUSE snapshot

Building the image inline would sit in the first line's path for minutes. Bake it
once into a named snapshot (`mirage-fuse`); creating a sandbox from it then takes
seconds. Re-run after a Mirage release to refresh the baked package.

```bash
./python/.venv/bin/python examples/python/runtimes/daytona/prebake_snapshot.py
```

## Run: the workspace runtime (CLI)

Create and provision a sandbox from the snapshot (prints its id; provisioning
status goes to stderr), then wire the workspace to it. From the repo root:

```bash
set -a; source .env.development; set +a
export DAYTONA_SANDBOX_ID=$(./python/.venv/bin/python \
  examples/python/runtimes/daytona/create_sandbox.py)
mirage workspace create examples/python/runtimes/daytona/daytona_workspace.yaml --id daytona-demo

printf 'print("hello from the sandbox")\n' \
  | mirage execute -w daytona-demo -c 'cat > /data/hello.py'

# Same prefix on both sides, so the path passes through verbatim.
mirage execute -w daytona-demo -c 'cd /data && python3 hello.py'

mirage workspace delete daytona-demo   # the sandbox stays yours
```

The sandbox is yours to keep or delete (`daytona sandbox delete`, the
dashboard, or just let the idle-stop/auto-delete timers set by
`create_sandbox.py` clean it up).

The `cat > /data/hello.py` write runs on the local vfs and lands in S3; the
`python3` line then reads the same file inside the sandbox through the live
mount.

## Run: standalone SDK demos (no snapshot needed)

Two self-contained scripts drive the Daytona SDK directly and build their image
inline (slower first boot, but nothing to prebake):

```bash
# Sandbox runs Mirage and FUSE-mounts S3, then reads /s3 natively.
./python/.venv/bin/python examples/python/runtimes/daytona/daytona_fuse.py

# Same, but Mirage reads S3 through its vfs API with no FUSE mount.
./python/.venv/bin/python examples/python/runtimes/daytona/daytona_vfs.py
```

`daytona_fuse.py` expects the bucket to contain `data/example.jsonl`. Expected
tail:

```
=== remote output ===
FUSE mountpoint: /home/daytona/.../s3
--- native os.listdir() against FUSE path ---
  data
--- native open() reads through FUSE ---
  size: NNNN bytes
  head:
  ...
```

## GPU sandboxes

Sizing, GPUs, and lifecycle are Daytona settings you pick when you create the
sandbox, not mirage options. For a GPU box, create it from an image sized with
`Resources(gpu=...)` (Daytona requires an image for per-sandbox resources) with
`fuse3` + `mirage-ai[s3,fuse]` baked in, then hand mirage its id as usual.

## Notes

- Not run in CI. It needs a Daytona account, a baked snapshot, and live AWS
  credentials.
- Lifecycle safety net: `create_sandbox.py` sets idle-stop after 10 minutes and
  auto-delete 30 minutes later, so a forgotten demo box cleans itself up.
