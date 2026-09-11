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
import json
import os

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.seaweedfs import SeaweedFSConfig, SeaweedFSResource

load_dotenv(".env.development")

config = SeaweedFSConfig(
    bucket=os.environ.get("SEAWEEDFS_BUCKET", "mirage-demo"),
    endpoint_url=os.environ.get("SEAWEEDFS_ENDPOINT", "http://localhost:8333"),
    access_key_id=os.environ.get("SEAWEEDFS_ACCESS_KEY", "any"),
    secret_access_key=os.environ.get("SEAWEEDFS_SECRET_KEY", "any"),
)

resource = SeaweedFSResource(config)


async def main():
    with Workspace({"/seaweedfs/": resource}, mode=MountMode.WRITE) as ws:
        print(f"=== VFS MODE: open() reads SeaweedFS at {config.endpoint_url} "
              f"transparently ===\n")

        # Seed a few objects so the demo is self-contained.
        await ws.fs.write(
            "/seaweedfs/data/example.jsonl",
            b'{"event":"queue-operation","tool":"mirage"}\n'
            b'{"event":"read","tool":"mirage"}\n'
            b'{"event":"queue-operation","tool":"other"}\n')
        await ws.fs.write(
            "/seaweedfs/data/config.json",
            b'{"name":"mirage","version":1,"tags":["s3","seaweedfs"]}')
        await ws.fs.write("/seaweedfs/notes.txt", b"hello from seaweedfs\n")

        print("--- os.listdir() root ---")
        for e in os.listdir("/seaweedfs"):
            print(f"  {e}")

        print("\n--- os.path.isdir() on prefix ---")
        print(f"  /seaweedfs/data: {os.path.isdir('/seaweedfs/data')}")

        print("\n--- os.listdir() data ---")
        for e in os.listdir("/seaweedfs/data"):
            print(f"  {e}")

        print("\n--- open() + read example.jsonl (first 3 lines) ---")
        with open("/seaweedfs/data/example.jsonl") as f:
            for i, line in enumerate(f):
                if i >= 3:
                    break
                rec = json.loads(line)
                print(f"  [{i}] {json.dumps(rec)[:100]}...")

        print("\n--- os.path.exists() ---")
        print(f"  example.jsonl: "
              f"{os.path.exists('/seaweedfs/data/example.jsonl')}")
        print(f"  nonexistent: {os.path.exists('/seaweedfs/data/nope.txt')}")

        print("\n--- os.path.getsize() ---")
        print(f"  notes.txt: {os.path.getsize('/seaweedfs/notes.txt')} bytes")

        print("\n--- VFS commands ---")
        result = await ws.execute("grep -c queue-operation "
                                  "/seaweedfs/data/example.jsonl")
        print(f"  grep matches: {(await result.stdout_str()).strip()}")
        result = await ws.execute("jq .tags /seaweedfs/data/config.json")
        print(f"  jq .tags    : {(await result.stdout_str()).strip()}")

        print("\n--- cleanup ---")
        for key in ("/seaweedfs/data/example.jsonl",
                    "/seaweedfs/data/config.json", "/seaweedfs/notes.txt"):
            await ws.execute(f"rm {key}")
        print("  cleaned")

        records = ws.fs.records
        total = sum(r.bytes for r in records)
        print(f"\nStats: {len(records)} ops, {total} bytes transferred")


asyncio.run(main())
