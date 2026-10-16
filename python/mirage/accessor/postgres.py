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

import asyncpg

from mirage.accessor.base import Accessor
from mirage.vfs.postgres.config import PostgresConfig
from mirage.vfs.secrets import reveal_secret

# The session every connection opens: read only, and the settings a date
# or time type's text depends on, pinned so a value spells the same
# whatever the server's defaults.
SESSION = {
    "default_transaction_read_only": "on",
    "DateStyle": "ISO",
    "IntervalStyle": "postgres",
    "TimeZone": "UTC",
}
# The date and time types a row keeps as the text Postgres sends, which
# holds what a datetime or timedelta cannot: a BC or five-digit year,
# infinity, 24:00:00, an interval's months.
TEXT_TYPES = ("date", "time", "timetz", "timestamp", "timestamptz", "interval")


async def read_as_text(conn: asyncpg.Connection) -> None:
    """Have a connection keep each of ``TEXT_TYPES`` as its text, arrays
    and domains of it included, and send a value of it as text.

    Args:
        conn (asyncpg.Connection): a new pool connection.
    """
    for name in TEXT_TYPES:
        await conn.set_type_codec(
            name,
            schema="pg_catalog",
            encoder=str,
            decoder=str,
            format="text",
        )


class PostgresAccessor(Accessor):
    def __init__(self, config: PostgresConfig) -> None:
        self.config = config
        self._lock = asyncio.Lock()
        self._pool: asyncpg.Pool | None = None

    async def pool(self) -> asyncpg.Pool:
        async with self._lock:
            if self._pool is None:
                self._pool = await asyncpg.create_pool(
                    reveal_secret(self.config.dsn),
                    server_settings=SESSION,
                    init=read_as_text,
                    min_size=1,
                    max_size=4,
                )
            return self._pool

    async def close(self) -> None:
        async with self._lock:
            if self._pool is not None:
                await self._pool.close()
                self._pool = None
