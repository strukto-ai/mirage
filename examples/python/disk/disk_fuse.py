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

import os
import shutil
import tempfile
from pathlib import Path

from mirage import Mount, MountMode, Workspace
from mirage.resource.disk import DiskResource

REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = REPO_ROOT / "data"

tmp = tempfile.mkdtemp()
shutil.copytree(DATA_DIR, Path(tmp) / "files", dirs_exist_ok=True)

resource = DiskResource(root=tmp + "/files")

with Workspace({"/data/": Mount(resource, mode=MountMode.READ,
                                fuse=True)}) as ws:
    mp = ws.fuse_mountpoint

    print(f"=== FUSE MODE: mounted at {mp} ===\n")

    data_path = mp

    print("--- os.listdir() ---")
    entries = os.listdir(data_path)
    for e in entries:
        size = os.path.getsize(f"{data_path}/{e}")
        print(f"  {e:30s} {size:>10,} bytes")

    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Open another terminal and try:")
    print(f">>>   ls -la {mp}/")
    print(f">>>   cat {mp}/example.json")
    print(f">>>   cat {mp}/example.json | jq .")
    print(">>> Press Enter to unmount and exit...")
    input()

    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, {total} bytes transferred")
