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
import os

from dotenv import load_dotenv

from mirage import Mount, MountMode, Workspace
from mirage.resource.seaweedfs import SeaweedFSConfig, SeaweedFSResource

load_dotenv(".env.development")

config = SeaweedFSConfig(
    bucket=os.environ.get("SEAWEEDFS_BUCKET", "mirage-demo"),
    endpoint_url=os.environ.get("SEAWEEDFS_ENDPOINT", "http://localhost:8333"),
    access_key_id=os.environ.get("SEAWEEDFS_ACCESS_KEY", "any"),
    secret_access_key=os.environ.get("SEAWEEDFS_SECRET_KEY", "any"),
)

resource = SeaweedFSResource(config)

SEED_KEYS = ("/seaweedfs/data/example.jsonl", "/seaweedfs/data/config.json",
             "/seaweedfs/notes.txt")


async def seed(ws: Workspace) -> None:
    await ws.ops.write(
        "/seaweedfs/data/example.jsonl",
        b'{"event":"queue-operation","tool":"mirage"}\n'
        b'{"event":"read","tool":"mirage"}\n'
        b'{"event":"queue-operation","tool":"other"}\n')
    await ws.ops.write(
        "/seaweedfs/data/config.json",
        b'{"name":"mirage","version":1,"tags":["s3","seaweedfs"]}')
    await ws.ops.write("/seaweedfs/notes.txt", b"hello from seaweedfs\n")


async def cleanup(ws: Workspace) -> None:
    for key in SEED_KEYS:
        await ws.execute(f"rm {key}")


mounts = {"/seaweedfs/": Mount(resource, mode=MountMode.WRITE, fuse=True)}
with Workspace(mounts) as ws:
    asyncio.run(seed(ws))
    mp = ws.fuse_mountpoint

    print(f"=== FUSE MODE: SeaweedFS mounted at {mp} ===\n")

    print("--- os.listdir() ---")
    for e in os.listdir(f"{mp}/data"):
        print(f"  {e}")

    print("\n--- open() + read ---")
    with open(f"{mp}/data/example.jsonl") as f:
        for i, line in enumerate(f):
            if i >= 3:
                break
            print(f"  [{i}] {line.strip()[:100]}...")

    print("\n--- os.path.getsize() ---")
    size = os.path.getsize(f"{mp}/data/example.jsonl")
    print(f"  size: {size} bytes")

    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Open another terminal and run:")
    print(f">>>   ls {mp}/data/")
    print(f">>>   cat {mp}/data/config.json")
    print(">>> Press Enter to unmount and exit...")
    try:
        input()
    except EOFError:
        pass

    asyncio.run(cleanup(ws))

    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, {total} bytes transferred")
