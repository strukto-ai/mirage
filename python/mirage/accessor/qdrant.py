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

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import partial
from typing import Any

from qdrant_client import AsyncQdrantClient

from mirage.accessor.base import Accessor
from mirage.accessor.pool import LoopClientCache
from mirage.core.qdrant.types import QdrantRow
from mirage.vfs.qdrant.config import QdrantConfig
from mirage.vfs.secrets import reveal_secret


@asynccontextmanager
async def _open(config: QdrantConfig) -> AsyncIterator[AsyncQdrantClient]:
    kwargs: dict[str, Any] = {
        "api_key": reveal_secret(config.api_key)
        if config.api_key is not None
        else None,
        "cloud_inference": config.cloud_inference,
    }
    if config.url:
        kwargs["url"] = config.url
    else:
        kwargs["host"] = config.host
        kwargs["port"] = config.port
        kwargs["https"] = config.https
    client = AsyncQdrantClient(**kwargs)
    try:
        yield client
    finally:
        await client.close()


class QdrantAccessor(Accessor):
    def __init__(self, config: QdrantConfig) -> None:
        self.config = config
        self._clients = LoopClientCache[AsyncQdrantClient]("qdrant")
        self.search_cache: dict[tuple[str, str, int], list[QdrantRow]] = {}
        self.indexes_ensured: set[str] = set()

    async def client(self) -> AsyncQdrantClient:
        """Return this loop's client, opening one when there is none."""
        return await self._clients.get(partial(_open, self.config))

    async def close(self) -> None:
        """Close every client this accessor opened, and drop its caches."""
        self.search_cache.clear()
        self.indexes_ensured.clear()
        await self._clients.close()
