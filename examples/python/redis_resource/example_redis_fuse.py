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

from mirage import Mount, MountMode, Workspace
from mirage.resource.redis import RedisResource

REDIS_URL = "redis://localhost:6379/0"
KEY_PREFIX = "mirage:fs:"


async def _seed():
    resource = RedisResource(url=REDIS_URL, key_prefix=KEY_PREFIX)
    ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
    await ws.execute('echo "hello world" | tee /data/hello.txt')
    await ws.execute("mkdir /data/sub")
    await ws.execute('echo "nested content" | tee /data/sub/nested.txt')
    await ws.execute('echo \'{"key": "value"}\' | tee /data/example.json')


asyncio.run(_seed())
print("Seeded Redis with sample files")

resource = RedisResource(url=REDIS_URL, key_prefix=KEY_PREFIX)

with Workspace({"/data/": Mount(resource, mode=MountMode.WRITE,
                                fuse=True)}) as ws:
    mp = ws.fuse_mountpoint

    print(f"\n=== FUSE MODE: mounted at {mp} ===\n")

    data_path = mp

    print("--- os.listdir() ---")
    entries = os.listdir(data_path)
    for e in entries:
        full = f"{data_path}/{e}"
        if os.path.isfile(full):
            size = os.path.getsize(full)
            print(f"  {e:30s} {size:>10,} bytes")
        else:
            print(f"  {e:30s} <dir>")

    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Open another terminal and try:")
    print(f">>>   ls -la {mp}/")
    print(f">>>   cat {mp}/hello.txt")
    print(f">>>   cat {mp}/example.json | jq .")
    print(">>> Press Enter to unmount and exit...")
    input()

    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, {total} bytes transferred")
