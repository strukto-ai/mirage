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

import argparse
import asyncio
import subprocess
import sys
import tempfile

from mirage.fuse.mount import mount_background
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def unmount(mountpoint: str) -> None:
    if sys.platform == "darwin":
        subprocess.run(
            ["diskutil", "unmount", "force", mountpoint], capture_output=True
        )
    else:
        subprocess.run(["fusermount", "-u", mountpoint], capture_output=True)


async def print_files(ws: Workspace) -> None:
    for path in await ws.vfs.readdir("/"):
        if await ws.vfs.is_dir(path):
            print(f"\n--- {path}/ (directory) ---")
            continue
        content = await ws.vfs.read(path)
        print(f"\n--- {path} ({len(content)} bytes) ---")
        print(content.decode(errors="replace"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--prompt", default="write a hello world script in hello.py"
    )
    args = parser.parse_args()

    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)

    with tempfile.TemporaryDirectory() as mountpoint:
        t = mount_background(ws.vfs, mountpoint)
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
    asyncio.run(print_files(ws))


if __name__ == "__main__":
    main()
