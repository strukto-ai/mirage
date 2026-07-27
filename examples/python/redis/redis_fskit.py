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

from mirage import Mount, MountBackend, MountMode, Workspace
from mirage.resource.redis import RedisResource

load_dotenv(".env.development")

# Use a non-zero db locally: a shared db0 often carries tens of thousands of
# unrelated keys, which makes prefix scans crawl.
resource = RedisResource(
    url=os.environ.get("REDIS_URL", "redis://localhost:6379/1"),
    key_prefix="mirage:fskit:",
)

# Redis is a byte store: stat() reads the value length from Redis without
# fetching content, so every file has a known size and FSKit can serve it.
with Workspace({
        "/kv/":
        Mount(resource, mode=MountMode.WRITE, backend=MountBackend.FSKIT)
}) as ws:
    mp = ws.fuse_mountpoint

    print(f"=== FSKIT MODE: mounted at {mp} ===\n")

    with open(f"{mp}/hello.txt", "w") as f:
        f.write("written through an fskit mount\n")

    print("--- os.listdir() ---")
    for e in sorted(os.listdir(mp)):
        size = os.path.getsize(f"{mp}/{e}")
        print(f"  {e:30s} {size:>10,} bytes")

    print("\n--- read back through the kernel ---")
    with open(f"{mp}/hello.txt") as f:
        print(f"  {f.read().strip()!r}")

    print(f"\n>>> mounted at: {mp}")
    print(">>> Open another terminal and try:")
    print(f">>>   ls -la {mp}/")
    print(f">>>   cat {mp}/hello.txt")
    print(">>> Press Enter to unmount and exit...")
    input()
