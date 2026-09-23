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

from mirage.cache.file.redis import RedisFileCacheStore

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")


async def main() -> None:
    # A Redis-backed file cache: file content is stored in Redis, so two
    # Mirage processes sharing a key_prefix share one content cache.
    key_prefix = "mirage:example:cache:"
    cache = RedisFileCacheStore(url=REDIS_URL, key_prefix=key_prefix)

    print("=== RedisFileCacheStore: FileCache backed by Redis ===")
    await cache.set("/data/hello.txt", b"hello from redis cache")
    got = await cache.get("/data/hello.txt")
    print(f"cache.get: {got.decode() if got else '(none)'}")

    # Another store with the same key_prefix sees the same data.
    cache2 = RedisFileCacheStore(url=REDIS_URL, key_prefix=key_prefix)
    got2 = await cache2.get("/data/hello.txt")
    print(f"cache2.get: {got2.decode() if got2 else '(none)'}")

    await cache.clear()
    print("wiped cache keys from Redis")


if __name__ == "__main__":
    asyncio.run(main())
