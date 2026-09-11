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

import asyncio
import errno
import os
import shutil
import stat as stat_mod
import tempfile
from pathlib import Path

from mirage import MountMode, Workspace
from mirage.resource.disk import DiskResource

REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = REPO_ROOT / "data"

tmp = tempfile.mkdtemp()
shutil.copytree(DATA_DIR, Path(tmp) / "files", dirs_exist_ok=True)

resource = DiskResource(root=tmp + "/files")


async def main():
    ws = Workspace({"/data/": resource}, mode=MountMode.READ)

    with ws:
        print("=== VFS MODE ===\n")

        print("--- os.listdir() ---")
        for entry in sorted(os.listdir("/data")):
            print(f"  {entry}")

        print("\n--- open() + read ---")
        with open("/data/example.json") as f:
            print(f"  {f.read().strip()}")

        print("\n--- os.path.exists() ---")
        print(f"  example.json: {os.path.exists('/data/example.json')}")
        print(f"  nope.txt: {os.path.exists('/data/nope.txt')}")

        print("\n--- os.path.isdir() ---")
        print(f"  /data: {os.path.isdir('/data')}")

        print("\n--- os.stat() ---")
        st = os.stat("/data/example.json")
        sized = os.path.getsize("/data/example.json")
        print(f"  example.json: regular file: {stat_mod.S_ISREG(st.st_mode)}")
        print(f"  matches getsize: {st.st_size == sized}")

        print("\n--- os.walk() ---")
        for top, dirs, files in os.walk("/data"):
            print(f"  {top}: {len(dirs)} dirs, {len(files)} files")

        print("\n--- read-only mount ---")
        # The mount mode is the access control, so a write verb is
        # refused at the door with the read-only errno rather than
        # reaching the disk.
        try:
            os.remove("/data/example.json")
        except OSError as exc:
            refused = errno.errorcode.get(exc.errno, str(exc.errno))
            print(f"  os.remove: {refused}")
        print(f"  access W_OK: {os.access('/data/example.json', os.W_OK)}")

        print("\n--- the backend's own host paths ---")
        # The patch is process-wide, so the disk resource's own os calls
        # pass through it too; they name host paths under the resource
        # root, which no mount owns, and reach the real filesystem.
        print(f"  host copy readable: "
              f"{Path(tmp, 'files', 'example.json').is_file()}")

        records = ws.fs.records
        total = sum(r.bytes for r in records)
        print(f"\nStats: {len(records)} ops, {total} bytes transferred")


asyncio.run(main())
