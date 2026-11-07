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
import threading
from collections.abc import Coroutine, Sequence
from typing import Any, TypeVar
from urllib.parse import urlsplit

import asyncpg

from mirage.vfs.sql.types import SqlDialect, SqlRow, SqlStatement, SqlValue

T = TypeVar("T")


def _numbered(sql: str) -> str:
    """A statement with its ``?`` parameters numbered ``$1``, ``$2``, as
    Postgres numbers them; no statement the sql ops run holds a ``?`` in
    a literal.

    Args:
        sql (str): the statement.
    """
    parts = sql.split("?")
    return parts[0] + "".join(
        f"${n}{part}" for n, part in enumerate(parts[1:], 1)
    )


def _serve(loop: asyncio.AbstractEventLoop) -> None:
    """Run a driver's loop on its thread until the driver closes.

    Args:
        loop (asyncio.AbstractEventLoop): the driver's loop.
    """
    asyncio.set_event_loop(loop)
    loop.run_forever()
    loop.close()


class PostgresSqlDriver:
    """A Postgres database reached with asyncpg, as the sql mount's
    driver and the SQL state store's.

    ``SqlDriver`` is synchronous, as ``sqlite3`` is, and asyncpg is
    async only, so the driver keeps its pool on an event loop of its
    own, on a thread of its own, and each statement waits there for its
    answer. The loop and the pool start on the first statement, and a
    batch holds one of the pool's connections for its transaction.
    ``location`` is the server and database without the credentials.
    Mirrors TypeScript's ``PostgresSqlDriver``.
    """

    def __init__(self, dsn: str) -> None:
        """Args:
        dsn (str): the database's ``postgres://`` URL.
        """
        parts = urlsplit(dsn)
        port = f":{parts.port}" if parts.port else ""
        self._dsn = dsn
        self._location = (
            f"{parts.scheme}://{parts.hostname or ''}{port}{parts.path}"
        )
        self._loop: asyncio.AbstractEventLoop | None = None
        self._pool: asyncpg.Pool | None = None
        self._lock = threading.Lock()

    @property
    def location(self) -> str:
        return self._location

    @property
    def dialect(self) -> SqlDialect:
        return SqlDialect.POSTGRES

    def _run(self, work: Coroutine[Any, Any, T]) -> T:
        """Run one coroutine on the driver's loop and wait for it,
        starting the loop and the pool first.

        Args:
            work (Coroutine[Any, Any, T]): what to run.
        """

        async def connect() -> asyncpg.Pool:
            return await asyncpg.create_pool(self._dsn, min_size=1, max_size=4)

        with self._lock:
            if self._loop is None:
                loop = asyncio.new_event_loop()
                threading.Thread(
                    target=_serve,
                    args=(loop,),
                    name="mirage-postgres",
                    daemon=True,
                ).start()
                try:
                    self._pool = asyncio.run_coroutine_threadsafe(
                        connect(), loop
                    ).result()
                except BaseException:
                    loop.call_soon_threadsafe(loop.stop)
                    raise
                self._loop = loop
            loop = self._loop
        return asyncio.run_coroutine_threadsafe(work, loop).result()

    def _connections(self) -> asyncpg.Pool:
        """The pool, once ``_run`` started it."""
        if self._pool is None:
            raise RuntimeError("postgres driver is closed")
        return self._pool

    def query(self, sql: str, params: Sequence[SqlValue] = ()) -> list[SqlRow]:
        async def run() -> list[SqlRow]:
            rows = await self._connections().fetch(_numbered(sql), *params)
            return [dict(row) for row in rows]

        return self._run(run())

    def batch(self, statements: Sequence[SqlStatement]) -> None:
        async def run() -> None:
            async with self._connections().acquire() as conn:
                async with conn.transaction():
                    for s in statements:
                        await conn.execute(_numbered(s.sql), *s.params)

        self._run(run())

    def close(self) -> None:
        with self._lock:
            loop, pool = self._loop, self._pool
            self._loop = self._pool = None
        if loop is None:
            return
        if pool is not None:
            asyncio.run_coroutine_threadsafe(pool.close(), loop).result()
        loop.call_soon_threadsafe(loop.stop)
