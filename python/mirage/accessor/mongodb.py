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
import time
from collections.abc import Awaitable, Callable
from typing import Any

from motor.motor_asyncio import AsyncIOMotorClient

from mirage.accessor.base import Accessor
from mirage.resource.mongodb.config import MongoDBConfig


class MongoDBAccessor(Accessor):

    def __init__(self,
                 config: MongoDBConfig,
                 listing_cache_ttl: float = 5.0) -> None:
        self.config = config
        self.listing_cache_ttl = listing_cache_ttl
        self._clients: dict[int, AsyncIOMotorClient] = {}
        self._cache: dict[str, tuple[float, Any]] = {}

    @property
    def client(self) -> AsyncIOMotorClient:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return self._for_loop(None)
        return self._for_loop(loop)

    def _for_loop(
            self,
            loop: asyncio.AbstractEventLoop | None) -> AsyncIOMotorClient:
        key = id(loop) if loop is not None else 0
        client = self._clients.get(key)
        if client is None:
            client = AsyncIOMotorClient(self.config.uri)
            self._clients[key] = client
        return client

    async def cached_list(self, key: str,
                          fetch: Callable[[], Awaitable[Any]]) -> Any:
        if self.listing_cache_ttl <= 0:
            return await fetch()
        now = time.monotonic()
        hit = self._cache.get(key)
        if hit is not None and hit[0] > now:
            return hit[1]
        value = await fetch()
        self._cache[key] = (now + self.listing_cache_ttl, value)
        return value

    def invalidate_listings(self) -> None:
        self._cache.clear()
