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
import tempfile
from collections import deque
from typing import BinaryIO, Protocol

from fastapi import HTTPException

from mirage.concurrency.limiter import on_loop, run_blocking
from mirage.io.cooperative import CHUNK_SIZE
from mirage.io.pipe import CAPACITY
from mirage.server.constants import MAX_STDIN_BYTES


class StdinSource(Protocol):
    """Input a line pulls chunk by chunk, ending with ``b""``."""

    async def read(self) -> bytes: ...


class LoopStdin:
    """Input that lives on the server loop, as a line's stdin.

    The line runs on the workspace runner's loop while an SSH channel or
    an HTTP upload lives on the server's, so each pull hops to the
    server loop for the next chunk and waits there.

    Args:
        source (StdinSource): the input.
        loop (asyncio.AbstractEventLoop): the loop the input lives on.
    """

    def __init__(
        self, source: StdinSource, loop: asyncio.AbstractEventLoop
    ) -> None:
        self._source = source
        self._loop = loop

    def __aiter__(self) -> "LoopStdin":
        return self

    async def __anext__(self) -> bytes:
        data = await on_loop(self._source.read(), self._loop)
        if not data:
            raise StopAsyncIteration
        return data


class UploadStdin:
    """Stream an upload with bounded memory and spill unread bytes to disk.

    Receiving must continue even when a command does not read stdin: the
    request reader also owns disconnect and malformed-body notification.
    """

    def __init__(
        self, capacity: int = CAPACITY, limit: int = MAX_STDIN_BYTES
    ) -> None:
        self._capacity = capacity
        self._limit = limit
        self._received = 0
        self._chunks: deque[bytes] = deque()
        self._buffered = 0
        self._file: BinaryIO | None = None
        self._written = 0
        self._read = 0
        self._ended = False
        self._discarding = False
        self.error: Exception | None = None
        self._changed = asyncio.Event()
        self._lock = asyncio.Lock()

    async def feed(self, data: bytes) -> None:
        """Accept bytes without waiting for the command to consume stdin.

        Args:
            data (bytes): the next uploaded chunk.
        """
        for offset in range(0, len(data), CHUNK_SIZE):
            async with self._lock:
                if self._discarding:
                    return
                chunk = data[offset : offset + CHUNK_SIZE]
                self._received += len(chunk)
                if self._received > self._limit:
                    raise HTTPException(
                        status_code=413, detail="stdin part too large"
                    )
                if (
                    self._file is None
                    and self._buffered + len(chunk) <= self._capacity
                ):
                    self._chunks.append(chunk)
                    self._buffered += len(chunk)
                else:
                    await run_blocking(self._append, chunk)
                self._changed.set()

    def _append(self, data: bytes) -> None:
        if self._file is None:
            self._file = tempfile.TemporaryFile()
        self._file.seek(self._written)
        self._file.write(data)
        self._written += len(data)

    def _pull(self) -> bytes:
        assert self._file is not None
        self._file.seek(self._read)
        data = self._file.read(min(CHUNK_SIZE, self._written - self._read))
        self._read += len(data)
        if self._read == self._written:
            self._file.truncate(0)
            self._read = self._written = 0
        return data

    async def close(self) -> None:
        """Mark upload EOF, preserving any unread bytes."""
        self._ended = True
        self._changed.set()

    async def fail(self, error: Exception) -> None:
        """Record why the upload failed, then drop unread bytes.

        Args:
            error (Exception): the reason the upload failed.
        """
        self.error = error
        await self.discard()

    async def discard(self) -> None:
        """Drop unread bytes and join temporary-file cleanup."""
        self._discarding = True
        self._changed.set()
        async with self._lock:
            self._chunks.clear()
            self._buffered = 0
            if self._file is not None:
                await run_blocking(self._file.close)
                self._file = None

    async def read(self) -> bytes:
        """Return buffered input, waiting only when the upload has no data."""
        while not self._discarding:
            async with self._lock:
                if self._chunks:
                    data = self._chunks.popleft()
                    self._buffered -= len(data)
                    return data
                if self._read < self._written:
                    return await run_blocking(self._pull)
                if self._ended:
                    break
                self._changed.clear()
            await self._changed.wait()
        await self.discard()
        return b""
