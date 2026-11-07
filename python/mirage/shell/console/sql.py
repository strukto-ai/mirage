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
import logging
import threading
import time
from collections.abc import Awaitable, Callable

from mirage.concurrency.limiter import run_blocking
from mirage.shell.console.constants import SQL_POLL_SECONDS
from mirage.shell.console.types import Channel, ConsoleChunk, ReadResult
from mirage.vfs.sql.types import SqlDriver, SqlRow, SqlValue

logger = logging.getLogger(__name__)

# Every statement the sql console store runs, by name. Mirrors
# TypeScript's ``CONSOLE_SQL``.
CONSOLE_SQL: dict[str, str] = {
    "top": "SELECT seq, channel FROM mirage_console"
    " WHERE scope = ? AND name = ? ORDER BY seq DESC LIMIT 1",
    "append": "INSERT INTO mirage_console"
    " (scope, name, seq, ts, channel, data) VALUES (?, ?, ?, ?, ?, ?)"
    " ON CONFLICT (scope, name, seq) DO NOTHING RETURNING seq",
    "last": "SELECT seq, ts, channel, data FROM mirage_console"
    " WHERE scope = ? AND name = ? ORDER BY seq DESC LIMIT 1",
    "read": "SELECT seq, ts, channel, data FROM mirage_console"
    " WHERE scope = ? AND name = ? AND seq >= ? ORDER BY seq",
    "read_some": "SELECT seq, ts, channel, data FROM mirage_console"
    " WHERE scope = ? AND name = ? AND seq >= ? ORDER BY seq LIMIT ?",
}


def _bytes_of(value: SqlValue) -> bytes:
    """The bytes a BLOB or BYTEA column came back as.

    Args:
        value (SqlValue): the column's value.
    """
    return bytes(value) if isinstance(value, bytes) else b""


def _chunk_of(row: SqlRow) -> ConsoleChunk:
    """The chunk one ``mirage_console`` row holds.

    Args:
        row (SqlRow): the row.
    """
    return ConsoleChunk(
        seq=int(row["seq"] or 0),
        ts=float(row["ts"] or 0.0),
        channel=Channel(row["channel"]),
        data=_bytes_of(row["data"]),
    )


class SqlConsoleStore:
    """One job's console in a SQL database, as ``mirage_console`` rows: one
    per chunk, keyed by the console's name and its seq, so any process on
    the database reads, follows and ends it.

    A chunk's seq is one past the console's last, taken by a conditional
    insert that a concurrent append makes retry, so two writers never
    share a seq. The ending chunk is terminal, as in RAM and Redis: an
    append after a CONTROL chunk is dropped. Nothing is trimmed; the
    execution store drops a console once no job list names it.

    A database has no blocking read, so a waiting reader looks again
    every ``poll_seconds``; an append or a close through this store wakes
    its own readers at once, on whatever loop each waits on.

    Args:
        driver (SqlDriver): the database.
        scope (str): the workspace's scope in it.
        name (str): the console's name.
        ready (Callable[[], Awaitable[None]]): makes the tables, once.
        poll_seconds (float): how often a waiting reader looks again.
    """

    def __init__(
        self,
        driver: SqlDriver,
        scope: str,
        name: str,
        ready: Callable[[], Awaitable[None]],
        poll_seconds: float = SQL_POLL_SECONDS,
    ) -> None:
        self._driver = driver
        self._scope = scope
        self._name = name
        self._ready = ready
        self._poll = poll_seconds
        self._closed = False
        self._appends = 0
        self._waiters: list[
            tuple[asyncio.AbstractEventLoop, asyncio.Future[None]]
        ] = []
        self._lock = threading.Lock()

    @property
    def closed(self) -> bool:
        return self._closed

    async def _query(
        self, key: str, params: tuple[SqlValue, ...]
    ) -> list[SqlRow]:
        await self._ready()
        return await run_blocking(
            self._driver.query,
            CONSOLE_SQL[key],
            (self._scope, self._name, *params),
        )

    async def _top(self) -> tuple[int | None, bool]:
        """The console's last seq, None while it is empty, and whether it
        holds its ending, which is always its last chunk: one indexed
        row, however long the console."""
        rows = await self._query("top", ())
        if not rows:
            return None, False
        return int(rows[0]["seq"] or 0), rows[0]["channel"] == "control"

    async def append(self, channel: Channel, data: bytes) -> ConsoleChunk:
        while True:
            top, ended = await self._top()
            if ended:
                [row] = await self._query("last", ())
                return _chunk_of(row)
            chunk = ConsoleChunk(
                seq=0 if top is None else top + 1,
                ts=time.time(),
                channel=channel,
                data=data,
            )
            if await self._query(
                "append", (chunk.seq, chunk.ts, channel.value, data)
            ):
                self._wake()
                return chunk

    async def read_from(
        self, seq: int, limit: int | None = None
    ) -> ReadResult:
        rows = (
            await self._query("read", (seq,))
            if limit is None
            else await self._query("read_some", (seq, limit))
        )
        chunks = [_chunk_of(row) for row in rows]
        if chunks:
            return chunks, chunks[-1].seq + 1, False
        top, _ = await self._top()
        return [], min(seq, 0 if top is None else top + 1), False

    async def wait(self, seq: int) -> None:
        while not self._closed:
            seen = self._appends
            top, _ = await self._top()
            if top is not None and top >= seq:
                return
            await self._park(seen)

    async def wait_ended(self) -> None:
        while not self._closed:
            seen = self._appends
            _, ended = await self._top()
            if ended:
                return
            await self._park(seen)

    async def close(self) -> None:
        self._closed = True
        self._wake()

    async def _park(self, seen: int) -> None:
        """Wait for an append or a close through this store, or the next
        look, whichever comes first; nothing when one came since ``seen``.

        Args:
            seen (int): the appends counted before the last look.
        """
        loop = asyncio.get_running_loop()
        future: asyncio.Future[None] = loop.create_future()
        with self._lock:
            if self._closed or self._appends != seen:
                return
            self._waiters.append((loop, future))
        try:
            await asyncio.wait([future], timeout=self._poll)
        finally:
            with self._lock:
                if (loop, future) in self._waiters:
                    self._waiters.remove((loop, future))

    def _wake(self) -> None:
        """Wake every reader waiting through this store."""
        with self._lock:
            self._appends += 1
            waiters, self._waiters = self._waiters, []
        for loop, future in waiters:
            try:
                loop.call_soon_threadsafe(_resolve, future)
            except RuntimeError as exc:
                logger.debug("console waiter loop is gone: %s", exc)


def _resolve(future: asyncio.Future[None]) -> None:
    """Complete a waiter's future, unless it is done already.

    Args:
        future (asyncio.Future[None]): the waiter.
    """
    if not future.done():
        future.set_result(None)
