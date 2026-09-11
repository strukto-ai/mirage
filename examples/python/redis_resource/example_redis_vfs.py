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

import redis as sync_redis

from mirage import MountMode, Workspace
from mirage.resource.redis import RedisResource

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
KEY_PREFIX = "mirage:fs:"


async def _seed():
    resource = RedisResource(url=REDIS_URL, key_prefix=KEY_PREFIX)
    ws = Workspace({"/data": resource}, mode=MountMode.WRITE)
    await ws.execute('echo "hello world" | tee /data/hello.txt')
    await ws.execute("mkdir /data/sub")
    await ws.execute('echo "nested" | tee /data/sub/nested.txt')


asyncio.run(_seed())

resource = RedisResource(url=REDIS_URL, key_prefix=KEY_PREFIX)
ws = Workspace({"/data": resource}, mode=MountMode.WRITE)

with ws:
    print("=== VFS MODE ===\n")

    print("--- os.listdir() ---")
    entries = os.listdir("/data")
    for e in entries:
        print(f"  {e}")

    print("\n--- open() + read ---")
    with open("/data/hello.txt") as f:
        print(f"  {f.read().strip()}")

    print("\n--- os.path.exists() ---")
    print(f"  hello.txt: {os.path.exists('/data/hello.txt')}")
    print(f"  nope.txt: {os.path.exists('/data/nope.txt')}")

    print("\n--- os.path.isdir() ---")
    print(f"  /data/sub: {os.path.isdir('/data/sub')}")

    print("\n--- os.listdir() sub ---")
    for e in os.listdir("/data/sub"):
        print(f"  {e}")

    records = ws.fs.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, {total} bytes transferred")

# The seeded files outlive the process and share a namespace with the
# other redis examples, so drop them rather than leak into the next run.
sc = sync_redis.Redis.from_url(REDIS_URL)
for key in sc.scan_iter(f"{KEY_PREFIX}*"):
    sc.delete(key)
sc.close()
