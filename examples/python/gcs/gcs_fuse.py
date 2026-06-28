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

import json
import os

from dotenv import load_dotenv

from mirage import Mount, MountMode, Workspace
from mirage.resource.gcs import GCSConfig, GCSResource

load_dotenv(".env.development")

config = GCSConfig(
    bucket=os.environ["GCS_BUCKET"],
    access_key_id=os.environ["GCS_ACCESS_KEY_ID"],
    secret_access_key=os.environ["GCS_SECRET_ACCESS_KEY"],
)

resource = GCSResource(config)

with Workspace({"/gcs/": Mount(resource, mode=MountMode.READ,
                               fuse=True)}) as ws:
    mp = ws.fuse_mountpoint

    print(f"=== FUSE MODE: mounted at {mp} ===\n")

    print("--- os.listdir() ---")
    entries = os.listdir(f"{mp}/data")
    for e in entries:
        print(f"  {e}")

    print("\n--- open() + read example.json (first 5 lines) ---")
    with open(f"{mp}/data/example.json") as f:
        for i, line in enumerate(f):
            if i >= 5:
                break
            print(f"  {line.rstrip()[:120]}")

    print("\n--- open() + read example.jsonl (first 3 lines) ---")
    with open(f"{mp}/data/example.jsonl") as f:
        for i, line in enumerate(f):
            if i >= 3:
                break
            rec = json.loads(line)
            print(f"  [{i}] {json.dumps(rec)[:100]}...")

    print("\n--- os.path.getsize() ---")
    size = os.path.getsize(f"{mp}/data/example.json")
    print(f"  example.json: {size} bytes")

    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Open another terminal and run:")
    print(f">>>   ls {mp}/data/")
    print(f">>>   cat {mp}/data/example.json")
    print(">>> Press Enter to unmount and exit...")
    input()

    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, {total} bytes")
