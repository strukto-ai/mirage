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

from dotenv import load_dotenv

from mirage import Mount, MountMode, Workspace
from mirage.resource.hf_buckets import HfBucketsConfig, HfBucketsResource

load_dotenv(".env.development")

config = HfBucketsConfig(
    bucket=os.environ["HF_BUCKET_NAME"],
    token=os.environ["HF_TOKEN"],
)
resource = HfBucketsResource(config)

with Workspace({"/hf/": Mount(resource, mode=MountMode.READ,
                              fuse=True)}) as ws:
    mp = ws.fuse_mountpoint

    print(f"=== FUSE MODE: mounted at {mp} ===\n")

    print(f"--- os.listdir({mp}) ---")
    root_entries = os.listdir(mp)
    for e in root_entries:
        print(f"  {e}")

    data_dir = mp
    if "data" in root_entries and os.path.isdir(f"{mp}/data"):
        data_dir = f"{mp}/data"
        print(f"\n--- os.listdir({data_dir}) ---")
        for e in os.listdir(data_dir):
            print(f"  {e}")

    data_entries = os.listdir(data_dir)
    target = None
    for entry in data_entries:
        if entry.endswith(".jsonl") or entry.endswith(".json"):
            target = f"{data_dir}/{entry}"
            break

    if target:
        print(f"\n--- open({target}) + read 3 lines ---")
        with open(target) as f:
            for i, line in enumerate(f):
                if i >= 3:
                    break
                print(f"  [{i}] {line.strip()[:100]}")

        print(f"\n--- os.path.getsize({target}) ---")
        size = os.path.getsize(target)
        print(f"  size: {size} bytes")

    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Open another terminal and run:")
    print(f">>>   ls {mp}/data/")
    if target:
        print(f">>>   cat {target}")
    print(">>> Press Enter to unmount and exit...")
    try:
        input()
    except EOFError:
        pass

    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, {total} bytes transferred")
