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
from typing import Any

from pydantic import BaseModel, ConfigDict, SecretStr, field_validator
from pymongo import AsyncMongoClient

from mirage.accessor.base import Accessor
from mirage.resource.secrets import reveal_secret
from mirage.utils import key_prefix as kp


class GridFSConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    uri: SecretStr
    database: str
    bucket: str = "fs"
    key_prefix: str | None = None
    chunk_size_bytes: int | None = None

    @field_validator("key_prefix")
    @classmethod
    def _normalize_key_prefix(cls, v: str | None) -> str | None:
        return kp.normalize(v) or None


class GridFSAccessor(Accessor):

    def __init__(self, config: GridFSConfig) -> None:
        self.config = config
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
        # AsyncMongoClient binds to the event loop it was created under, so
        # keep one client per loop (mirrors MongoDBAccessor).
        key = id(loop) if loop is not None else 0
        client = self._clients.get(key)
        if client is None:
            client = AsyncMongoClient(reveal_secret(self.config.uri))
            self._clients[key] = client
        return client

    async def close(self) -> None:
        clients = list(self._clients.values())
        self._clients.clear()
        for client in clients:
            await client.close()
