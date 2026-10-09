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
from dataclasses import dataclass, field
from functools import partial
from typing import Any

import lancedb

from mirage.accessor.base import Accessor
from mirage.accessor.pool import LoopClientCache
from mirage.core.lancedb.types import LanceRow
from mirage.vfs.lancedb.config import LanceDBConfig
from mirage.vfs.secrets import reveal_secret


@dataclass
class _Connection:
    """One loop's open database and the tables opened on it.

    Args:
        db (lancedb.AsyncConnection): the open ``AsyncConnection``.
        tables (dict[str, lancedb.AsyncTable]): the tables opened so far, by name.
    """

    db: lancedb.AsyncConnection
    tables: dict[str, lancedb.AsyncTable] = field(default_factory=dict)


@asynccontextmanager
async def _open(config: LanceDBConfig) -> AsyncIterator[_Connection]:
    kwargs: dict[str, Any] = {}
    if config.api_key is not None:
        kwargs["api_key"] = reveal_secret(config.api_key)
    if config.storage_options:
        kwargs["storage_options"] = config.storage_options
    if config.uri.startswith("db://"):
        kwargs["region"] = config.region
        if config.host_override:
            kwargs["host_override"] = config.host_override
    db = await lancedb.connect_async(config.uri, **kwargs)
    try:
        yield _Connection(db=db)
    finally:
        db.close()


class LanceDBAccessor(Accessor):
    def __init__(self, config: LanceDBConfig) -> None:
        self.config = config
        self._connections = LoopClientCache[_Connection]("lancedb")
        self.search_cache: dict[tuple[str, str, int], list[LanceRow]] = {}

    async def _connection(self) -> _Connection:
        return await self._connections.get(partial(_open, self.config))

    async def db(self) -> lancedb.AsyncConnection:
        """Return this loop's database, connecting when there is none."""
        return (await self._connection()).db

    async def table(self, name: str) -> lancedb.AsyncTable:
        """Return one table, opened once per loop.

        Args:
            name (str): the table name.
        """
        conn = await self._connection()
        tbl = conn.tables.get(name)
        if tbl is None:
            tbl = await conn.db.open_table(name)
            conn.tables[name] = tbl
        return tbl

    async def close(self) -> None:
        """Close every database this accessor opened, and drop its cache."""
        self.search_cache.clear()
        await self._connections.close()
