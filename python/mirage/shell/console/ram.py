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

from mirage.shell.console.types import Channel, ConsoleChunk, ReadResult

logger = logging.getLogger(__name__)

Waiter = tuple[int, asyncio.AbstractEventLoop, "asyncio.Future[None]"]


def _resolve(future: "asyncio.Future[None]") -> None:
    """Complete a waiter's future, tolerating one that already finished.

    Args:
        future (asyncio.Future[None]): the waiter to wake.
    """
    if not future.done():
        future.set_result(None)


class RAMConsoleStore:
    """In-memory console storage, the default in every topology.

    Reads need no lock. Chunks are immutable and live in a list, so a
    reader on any thread sees either a complete chunk or one that is not
    visible yet, never a partial one.

    Waiting does need coordination, and it cannot use an asyncio
    primitive: a console is written by the task that owns the workspace
    but read from wherever a caller happens to be, including a pool
    thread running its own loop (``run_async_from_sync``) or a server's
    request loop. Condition variables are bound to one loop, so waiters
    park a future created on their own loop and the appender wakes them
    through ``call_soon_threadsafe``, the documented way into a loop from
    outside it. The mutex guards only registry membership, never bytes,
    and is never held across an await.

    Args:
        max_bytes (int | None): retention budget. When set, the oldest
            chunks are dropped once the total exceeds it, and a reader
            whose cursor was dropped is told rather than shorted.
        chunks (list[ConsoleChunk] | None): pre-existing chunks, used to
            rebuild a finished job's console from a snapshot.
    """

    def __init__(self,
                 max_bytes: int | None = None,
                 chunks: list[ConsoleChunk] | None = None) -> None:
        self._chunks: list[ConsoleChunk] = list(chunks) if chunks else []
        self._base_seq = self._chunks[0].seq if self._chunks else 0
        self._next_seq = self._chunks[-1].seq + 1 if self._chunks else 0
        self._bytes = sum(len(c.data) for c in self._chunks)
        self._max_bytes = max_bytes
        self._waiters: list[Waiter] = []
        self._lock = threading.Lock()
        self._closed = False

    @property
    def closed(self) -> bool:
        return self._closed

    async def append(self, channel: Channel, data: bytes) -> ConsoleChunk:
        chunk = ConsoleChunk(seq=self._next_seq,
                             ts=time.time(),
                             channel=channel,
                             data=data)
        self._chunks.append(chunk)
        self._next_seq += 1
        self._bytes += len(data)
        self._trim()
        self._wake()
        return chunk

    async def read_from(self,
                        seq: int,
                        limit: int | None = None) -> ReadResult:
        truncated = seq < self._base_seq
        start = 0 if truncated else min(seq -
                                        self._base_seq, len(self._chunks))
        window = (self._chunks[start:]
                  if limit is None else self._chunks[start:start + limit])
        return window, self._base_seq + start + len(window), truncated

    async def wait(self, seq: int) -> None:
        loop = asyncio.get_running_loop()
        future: asyncio.Future[None] = loop.create_future()
        with self._lock:
            # Checking under the same mutex the appender takes to wake
            # waiters is what closes the lost-wakeup window: a chunk
            # appended between this check and the registration below
            # would find the waiter already listed. A closed store is
            # checked here too, so a reader that re-arms after close()
            # woke it returns instead of parking forever.
            if self._closed or self._next_seq > seq:
                return
            self._waiters.append((seq, loop, future))
        await future

    async def close(self) -> None:
        with self._lock:
            self._closed = True
            waiters = self._waiters
            self._waiters = []
        for _, loop, future in waiters:
            self._schedule(loop, future)

    def _trim(self) -> None:
        if self._max_bytes is None:
            return
        while self._chunks and self._bytes > self._max_bytes:
            if self._chunks[0].channel == Channel.CONTROL:
                # The terminal chunk is what releases wait_finished()
                # and ends follow(); dropping it would leave both
                # blocked forever, so it outranks the byte budget.
                break
            dropped = self._chunks.pop(0)
            self._bytes -= len(dropped.data)
            self._base_seq += 1

    def _wake(self) -> None:
        with self._lock:
            matured = [w for w in self._waiters if w[0] < self._next_seq]
            if not matured:
                return
            self._waiters = [
                w for w in self._waiters if w[0] >= self._next_seq
            ]
        for _, loop, future in matured:
            self._schedule(loop, future)

    def _schedule(self, loop: asyncio.AbstractEventLoop,
                  future: "asyncio.Future[None]") -> None:
        """Wake one waiter on the loop it is parked on.

        Args:
            loop (asyncio.AbstractEventLoop): the waiter's own loop.
            future (asyncio.Future[None]): the waiter to complete.
        """
        try:
            loop.call_soon_threadsafe(_resolve, future)
        except RuntimeError as exc:
            # The waiter's loop shut down while it was parked. Its future
            # dies with the loop, so there is nobody left to notify.
            logger.debug("console waiter loop is gone: %s", exc)
