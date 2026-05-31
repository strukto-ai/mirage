# mirage-fuse

Expose any mirage Workspace (memory, S3, R2, HTTP) as a native macOS directory so Claude Code and any CLI tool can read and write remote files transparently.

## Prerequisites

```bash
brew install --cask macfuse
uv add mirage-fuse
```

### macOS Security Setup

1. Open **System Settings → Privacy & Security**. Scroll to the bottom — you'll see:

> "System software from developer 'Benjamin Fleischer' was blocked from loading."
> Click **Allow**.

2. **Restart your Mac.** macOS requires a reboot to load the kernel extension.
1. If you don't see the Allow button (Apple Silicon M1/M2/M3/M4):

- Shut down completely
- Hold power button until "Loading startup options" appears
- Click **Options → Continue**
- In Recovery: **Utilities → Startup Security Utility**
- Set to **Reduced Security** and check **"Allow user management of kernel extensions"**
- Restart, then retry step 1

## Usage

### CLI

```bash
# Mount an in-memory workspace as a real directory (writable)
mirage mount-fuse /data/:memory:// --mountpoint /tmp/ws/ --mode write --foreground
# (runs in foreground — open a new terminal for the next commands)

# In another terminal: any OS tool works natively
ls /tmp/ws/data/
echo "hello" > /tmp/ws/data/notes.txt
cat /tmp/ws/data/notes.txt

# Use Claude Code directly on the mounted path
cd /tmp/ws/data && claude -p "write a hello.py script here"

# Ctrl+C in the first terminal to unmount
```

For read-only S3/R2 access:

```bash
mirage mount-fuse /data/:s3://my-bucket --mountpoint /tmp/s3/ --mode read
claude -p "summarize the files in /tmp/s3/data/reports/"
# Ctrl+C to unmount
```

### Python API

```python
from mirage.backend.local.memory import MemoryBackend
from mirage.workspace import Workspace
from mirage.fuse.fs import MirageFS, mount

ws = Workspace({"/data/": MemoryBackend()}, mode="write")
mount(ws, "/tmp/ws/", foreground=True)
```

## Supported FUSE Operations

| Operation  | Description             |
| ---------- | ----------------------- |
| `getattr`  | File/directory metadata |
| `readdir`  | List directory contents |
| `read`     | Read file contents      |
| `write`    | Write file contents     |
| `create`   | Create new files        |
| `mkdir`    | Create directories      |
| `unlink`   | Delete files            |
| `rename`   | Move/rename files       |
| `truncate` | Resize files            |
| `open`     | Open existing files     |
| `release`  | Close file handles      |
