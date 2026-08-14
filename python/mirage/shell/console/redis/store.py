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

import time
from typing import cast

import redis.asyncio as aioredis
from redis import exceptions as redis_exceptions

from mirage.shell.console.redis.constants import APPEND_LUA, BLOCK_MS
from mirage.shell.console.types import Channel, ConsoleChunk, ReadResult


class RedisConsoleStore:
    """Console storage on a Redis stream, for readers in other processes.

    One stream per job: chunk ``seq`` maps to stream id ``(seq+1)-0``,
    with the channel, payload and timestamp as entry fields (``c``/
    ``d``/``t``). The job's process appends through its store instance;
    a reader anywhere else attaches its own instance on the same
    ``key_prefix`` and follows live, which is what RAM cannot offer.
    Both languages write the same schema, so the reader does not have to
    be the writer's language.

    The job owns its keys: a factory must hand every job a prefix
    nothing else has written, because a reused stream replays the
    previous job's chunks, ending chunk included. ``key_prefix`` stays
    public because it is the console's address: an embedder reads it off
    a job's store and hands it to the process that should attach.

    The ending chunk is terminal in the store itself, not only in this
    process: the append script refuses any append once a CONTROL chunk
    landed, so an emit that raced a kill past ``JobConsole``'s local
    guard is dropped server-side instead of landing after the ending.

    ``wait`` blocks server-side (XREAD BLOCK) in short rounds so a
    local ``close`` is noticed within one round. There is no retention
    trim, so ``read_from`` never reports a truncated cursor; retention
    is bounded by ``ttl_seconds`` instead, refreshed on every append,
    so a console expires that long after its job's last write.

    Args:
        url (str): Redis connection URL.
        key_prefix (str): namespace for this one console's keys.
        ttl_seconds (int | None): expire the keys this long after the
            last append. None keeps them until deleted by hand.
    """

    def __init__(
        self,
        url: str = "redis://localhost:6379/0",
        key_prefix: str = "mirage:console:",
        ttl_seconds: int | None = None,
    ) -> None:
        self.key_prefix = key_prefix
        self._client = aioredis.from_url(url)
        self._stream = f"{key_prefix}stream"
        self._counter = f"{key_prefix}seq"
        self._ended = f"{key_prefix}ended"
        self._ttl = ttl_seconds
        self._append_script = self._client.register_script(APPEND_LUA)
        self._closed = False

    @property
    def closed(self) -> bool:
        return self._closed

    async def append(self, channel: Channel, data: bytes) -> ConsoleChunk:
        """Append one chunk, atomically against the console's ending.

        A dropped append (the console already ended) reports the last
        real chunk's seq; ``JobConsole.emit`` ignores the return and the
        drop is exactly its documented after-the-ending semantics.

        Args:
            channel (Channel): which stream the bytes came from.
            data (bytes): the payload.
        """
        ts = time.time()
        ended = "1" if channel == Channel.CONTROL else "0"
        count = await self._append_script(
            keys=[self._stream, self._counter, self._ended],
            args=[channel.value, data,
                  repr(ts), ended,
                  str(self._ttl or 0)])
        return ConsoleChunk(seq=int(cast("int", count)) - 1,
                            ts=ts,
                            channel=channel,
                            data=data)

    async def read_from(self,
                        seq: int,
                        limit: int | None = None) -> ReadResult:
        pipe = self._client.pipeline()
        pipe.xrange(self._stream, min=f"{seq + 1}-0", max="+", count=limit)
        pipe.get(self._counter)
        entries, counter = await pipe.execute()
        chunks = [self._chunk(entry) for entry in entries]
        if chunks:
            return chunks, chunks[-1].seq + 1, chunks[0].seq > seq
        # An empty window still clamps the cursor the way RAM does, so a
        # follower armed past the end waits at the next real seq.
        total = int(counter) if counter is not None else 0
        return [], min(seq, total), False

    async def wait(self, seq: int) -> None:
        while not self._closed:
            try:
                resp = await self._client.xread({self._stream: f"{seq}-0"},
                                                count=1,
                                                block=BLOCK_MS)
            except redis_exceptions.ConnectionError:
                # close() tore down the client under a parked reader;
                # that is the documented way a wait ends early.
                if self._closed:
                    return
                raise
            if resp:
                return

    async def close(self) -> None:
        self._closed = True
        await self._client.aclose()

    async def clear(self) -> None:
        """Delete the console's keys (test and integ teardown only)."""
        await self._client.delete(self._stream, self._counter, self._ended)

    def _chunk(self, entry: tuple[bytes, dict[bytes, bytes]]) -> ConsoleChunk:
        """Decode one XRANGE entry back into a chunk.

        Args:
            entry (tuple[bytes, dict[bytes, bytes]]): stream id, fields.
        """
        entry_id, fields = entry
        return ConsoleChunk(seq=int(entry_id.split(b"-")[0]) - 1,
                            ts=float(fields[b"t"]),
                            channel=Channel(fields[b"c"].decode()),
                            data=fields[b"d"])
