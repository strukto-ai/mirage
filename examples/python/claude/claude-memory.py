# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
"""
Example: Run Claude Code inside a memory-backed FUSE filesystem.

All file operations from Claude happen in-memory — nothing touches disk.
After Claude exits, the workspace still holds everything Claude created.

Usage:
    python examples/claude/claude-memory.py
    python examples/claude/claude-memory.py \
        --prompt "write a fibonacci.py"
"""

import argparse
import subprocess
import sys
import tempfile

from mirage.fuse.mount import mount_background
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def unmount(mountpoint: str) -> None:
    if sys.platform == "darwin":
        subprocess.run(["diskutil", "unmount", "force", mountpoint],
                       capture_output=True)
    else:
        subprocess.run(["fusermount", "-u", mountpoint], capture_output=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt",
                        default="write a hello world script in /hello.py")
    args = parser.parse_args()

    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)

    with tempfile.TemporaryDirectory() as mountpoint:
        t = mount_background(ws, mountpoint)
        print(f"Mounted memory filesystem at {mountpoint}")

        try:
            subprocess.run(
                ["claude", "-p", args.prompt],
                cwd=mountpoint,
            )
        finally:
            unmount(mountpoint)
            t.join(timeout=3)

    print("\n=== Files Claude created (in memory) ===")
    for path in ws.ls("/"):
        try:
            content = ws.cat(path)
            print(f"\n--- {path} ({len(content)} bytes) ---")
            print(content.decode(errors="replace"))
        except (IsADirectoryError, ValueError):
            print(f"\n--- {path}/ (directory) ---")


if __name__ == "__main__":
    main()
