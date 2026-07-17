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

import lancedb

from mirage.accessor.base import Accessor
from mirage.resource.lancedb.config import LanceDBConfig
from mirage.resource.secrets import reveal_secret


class LanceDBAccessor(Accessor):

    def __init__(self, config: LanceDBConfig) -> None:
        self.config = config
        self._dbs: dict[int, Any] = {}
        self._tables: dict[tuple[int, str], Any] = {}
        self._search_cache: dict[tuple[str, str, int], list[dict[str,
                                                                 Any]]] = {}

    def _loop_key(self) -> int:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return 0
        return id(loop)

    async def db(self) -> Any:
        key = self._loop_key()
        db = self._dbs.get(key)
        if db is None:
            kwargs: dict[str, Any] = {}
            if self.config.api_key is not None:
                kwargs["api_key"] = reveal_secret(self.config.api_key)
            if self.config.storage_options:
                kwargs["storage_options"] = self.config.storage_options
            if self.config.uri.startswith("db://"):
                kwargs["region"] = self.config.region
                if self.config.host_override:
                    kwargs["host_override"] = self.config.host_override
            db = await lancedb.connect_async(self.config.uri, **kwargs)
            self._dbs[key] = db
        return db

    async def table(self, name: str) -> Any:
        key = (self._loop_key(), name)
        tbl = self._tables.get(key)
        if tbl is None:
            db = await self.db()
            tbl = await db.open_table(name)
            self._tables[key] = tbl
        return tbl

    def cached_search(
            self, key: tuple[str, str, int]) -> list[dict[str, Any]] | None:
        return self._search_cache.get(key)

    def store_search(self, key: tuple[str, str, int],
                     rows: list[dict[str, Any]]) -> None:
        self._search_cache[key] = rows

    async def close(self) -> None:
        dbs = list(self._dbs.values())
        self._dbs.clear()
        self._tables.clear()
        self._search_cache.clear()
        for db in dbs:
            db.close()
