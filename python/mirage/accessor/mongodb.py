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
from collections.abc import Iterable
from typing import Any

from pydantic import SecretStr
from pymongo import AsyncMongoClient

from mirage.accessor.base import Accessor
from mirage.accessor.responses import ResponseCache
from mirage.vfs.mongodb.config import MongoDBConfig
from mirage.vfs.secrets import reveal_secret


class MongoClientAccessor(Accessor):
    """An accessor holding one ``AsyncMongoClient`` per event loop.

    AsyncMongoClient binds to the event loop it was created under, so a
    client is kept per loop. MongoDB and GridFS both reach their server
    through it.

    Args:
        uri (SecretStr): the server's connection string.
    """

    def __init__(self, uri: SecretStr) -> None:
        self._uri = uri
        self._clients: dict[int, AsyncMongoClient[dict[str, Any]]] = {}

    @property
    def client(self) -> AsyncMongoClient[dict[str, Any]]:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return self._for_loop(None)
        return self._for_loop(loop)

    def _for_loop(
        self, loop: asyncio.AbstractEventLoop | None
    ) -> AsyncMongoClient[dict[str, Any]]:
        key = id(loop) if loop is not None else 0
        client = self._clients.get(key)
        if client is None:
            client = AsyncMongoClient(reveal_secret(self._uri))
            self._clients[key] = client
        return client

    async def close(self) -> None:
        clients = list(self._clients.values())
        self._clients.clear()
        for client in clients:
            await client.close()


class MongoDBAccessor(MongoClientAccessor):
    def __init__(
        self, config: MongoDBConfig, listing_cache_ttl: float = 5.0
    ) -> None:
        super().__init__(config.uri)
        self.config = config
        # The database and collection names an existence check reads.
        self.listings = ResponseCache[str, list[str]](listing_cache_ttl)

    def caches(self) -> Iterable[ResponseCache[Any, Any]]:
        return (self.listings,)

    async def close(self) -> None:
        self.forget()
        await super().close()
