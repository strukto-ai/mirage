# Python examples

Runnable scripts, laid out like the docs: `vfs/` holds one directory per
backend and `vfs/new/` the custom-VFS examples, `agents/` one per agent
framework, `runtime/sandbox/` one per sandbox, and `core/`, `cli/`,
`policy/`, `configuration/`, `integration/`, `notifications/` and `fuse/`
match the docs sections of the same name. Run them from the repo root with
the venv interpreter so `.env.development` resolves:

```bash
./python/.venv/bin/python examples/python/vfs/s3/s3.py
```

Naming: `<backend>.py` uses the command surface, `<backend>_fuse.py` adds a
kernel mount, `<backend>_vfs.py` stays fully virtual.

## Mount backends: fuse vs fskit

Apple has deprecated third-party kernel extensions; on Apple Silicon the
macFUSE kext already needs a reduced-security boot and admin approval, and
future macOS releases are expected to stop loading it entirely. FSKit
(macOS 15.4+) is Apple's supported userspace replacement, and macFUSE 5.x
can serve the same libfuse API through it. `backend=fskit` is mirage's path
to keep real mounts working on Macs where the kext is blocked.

```mermaid
flowchart LR
    A[cat /Volumes/.../file] --> K[kernel VFS]
    K -->|backend=fuse| X[macFUSE kext] --> L[libfuse]
    K -->|backend=fskit| F[fskitd + macFUSE FSKit module] --> L
    L --> M[MirageFS] --> R[vfs]
```

Same upper half either way; only the kernel-to-userspace hop changes.
Trade-off: fskit mounts live under `/Volumes` and need exact file sizes
(no `direct_io`), so API-backed mounts are refused. The full write
surface works (via `mirage/fuse/darwin.py`). `fuse/fskit.py` demonstrates
all of it; details in `docs/python/setup/fuse.mdx`.
