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
your machine (control plane)                 Daytona sandbox
  Workspace: /data -> S3Resource               mirage mount add /data --fuse ...
  captures ["python3"] -> DaytonaRuntime  -->    -> in-sandbox daemon
  vfs runs every other line locally             -> FUSE-mounts S3 at
                                                    /home/daytona/workspace/data
  cd /data; python3 train.py  ------------>      cwd rebased; train.py reads the mount
```

1. The workspace declares `/data` as an `S3Resource`. A `DaytonaRuntime` captures
   `python3` lines; everything else stays on the local vfs.
1. When the sandbox boots, each mount becomes one `mirage mount add <prefix> --fuse <path>` command inside the sandbox (the spec travels in the exec
   environment, never as a file), and the mount is served live from then on.
1. Mounts appear at `<workspace_root>/<prefix>` and the session cwd is rebased
   under the workspace root, so paths relative to the cwd just work. Mirage does
   not rewrite paths inside your command: keep them relative to the cwd.
1. The sandbox is created lazily on the first captured line and deleted when the
   workspace closes (or reused across runs when you pass a `sandbox_id`).

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

`daytona_workspace.yaml` wires the S3 mount to a Daytona runtime that boots from
the `mirage-fuse` snapshot. From the repo root:

```bash
set -a; source .env.development; set +a
mirage workspace create examples/python/runtimes/daytona/daytona_workspace.yaml --id daytona-demo

printf 'print("hello from the sandbox")\n' \
  | mirage execute -w daytona-demo -c 'cat > /data/hello.py'

# Relative path from the rebased cwd; mirage does not rewrite absolute paths.
mirage execute -w daytona-demo -c 'cd /data && python3 hello.py'

mirage workspace delete daytona-demo   # deletes the sandbox it created
```

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

Snapshot sandboxes fix their sizing at bake time. For a GPU sandbox, size it with
an **image** instead (Daytona requires an image for per-sandbox resources) and
bake `fuse3` + `mirage-ai[s3,fuse]` into that image. See the commented GPU entry
at the top of `daytona_workspace.yaml`.

## Notes

- Not run in CI. It needs a Daytona account, a baked snapshot, and live AWS
  credentials.
- Lifecycle safety net: the workspace yaml stops an idle sandbox after 10 minutes
  and deletes it 30 minutes later, so a forgotten demo cleans itself up.
