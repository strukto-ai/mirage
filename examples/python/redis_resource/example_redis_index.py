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
import time

from mirage import Workspace
from mirage.cache.index import (IndexEntry, RedisIndexCacheStore,
                                RedisIndexConfig)
from mirage.resource.ram import RAMResource

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")


def _file(name: str) -> IndexEntry:
    return IndexEntry(id=name, name=name, resource_type="file")


async def main() -> None:
    # A workspace-level ``index`` config points every mounted resource's
    # index cache at the same Redis instance. Two separate Mirage processes
    # that share a key_prefix then share one index -- the building block for
    # running the same mounts locally and in a remote sandbox.
    key_prefix = f"mirage:example:idx:{int(time.time() * 1000)}:"
    index_config = RedisIndexConfig(url=REDIS_URL, key_prefix=key_prefix)

    # Workspace A: a RAM mount whose INDEX is backed by Redis (not RAM).
    ram_a = RAMResource()
    Workspace({"/data": ram_a}, index=index_config)
    print("index store A is redis-backed: "
          f"{isinstance(ram_a.index, RedisIndexCacheStore)}")

    # Populate the shared Redis index through workspace A.
    await ram_a.index.put("/data/hello.txt", _file("hello.txt"))
    await ram_a.index.set_dir(
        "/data",
        [("hello.txt", _file("hello.txt")), ("notes.md", _file("notes.md"))],
    )

    # Workspace B: a separate resource pointed at the same Redis index
    # (same key_prefix). It sees what A cached without re-listing anything.
    ram_b = RAMResource()
    Workspace({"/data": ram_b}, index=index_config)

    entry = await ram_b.index.get("/data/hello.txt")
    name = entry.entry.name if entry.entry else "(none)"
    print(f"shared index entry: {name}")

    listing = await ram_b.index.list_dir("/data")
    print(f"shared index listing: {', '.join(listing.entries or [])}")

    await ram_a.index.clear()
    await ram_a.index.close()
    await ram_b.index.close()
    print("wiped test keys from Redis")


if __name__ == "__main__":
    asyncio.run(main())
