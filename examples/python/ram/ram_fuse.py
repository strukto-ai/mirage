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
from pathlib import Path

from mirage import Mount, MountMode, Workspace
from mirage.resource.ram import RAMResource

REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = REPO_ROOT / "data"

resource = RAMResource()
store = resource._store

for fpath in sorted(DATA_DIR.iterdir()):
    if fpath.is_file():
        key = "/" + fpath.name
        store.files[key] = fpath.read_bytes()
        store.dirs.add("/")

print(f"Loaded {len(store.files)} files from {DATA_DIR}")
for name in sorted(store.files):
    size = len(store.files[name])
    print(f"  {name} ({size:,} bytes)")

with Workspace({"/data/": Mount(resource, mode=MountMode.WRITE,
                                fuse=True)}) as ws:
    mp = ws.fuse_mountpoint

    print(f"\n=== FUSE MODE: mounted at {mp} ===\n")

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
    print(f">>>   cat {mp}/example.parquet")
    print(">>> Press Enter to unmount and exit...")
    input()

    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, {total} bytes transferred")
