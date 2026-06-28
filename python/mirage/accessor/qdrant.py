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

from qdrant_client import AsyncQdrantClient

from mirage.accessor.base import Accessor
from mirage.resource.qdrant.config import QdrantConfig
from mirage.resource.secrets import reveal_secret


class QdrantAccessor(Accessor):

    def __init__(self, config: QdrantConfig) -> None:
        self.config = config
        self._clients: dict[int, Any] = {}
        self._search_cache: dict[tuple[str, str, int], list[dict]] = {}
        self._indexes_ensured: set[str] = set()

    def _loop_key(self) -> int:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return 0
        return id(loop)

    async def client(self) -> Any:
        key = self._loop_key()
        client = self._clients.get(key)
        if client is None:
            api_key = (reveal_secret(self.config.api_key)
                       if self.config.api_key is not None else None)
            kwargs: dict = {
                "api_key": api_key,
                "cloud_inference": self.config.cloud_inference
            }
            if self.config.url:
                kwargs["url"] = self.config.url
            else:
                kwargs["host"] = self.config.host
                kwargs["port"] = self.config.port
                kwargs["https"] = self.config.https
            client = AsyncQdrantClient(**kwargs)
            self._clients[key] = client
        return client

    def cached_search(self, key: tuple[str, str, int]) -> list[dict] | None:
        return self._search_cache.get(key)

    def store_search(self, key: tuple[str, str, int],
                     rows: list[dict]) -> None:
        self._search_cache[key] = rows
