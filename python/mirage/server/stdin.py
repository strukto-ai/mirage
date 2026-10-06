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
from typing import Protocol

# How many received chunks an upload may run ahead of the line reading
# it before the server stops reading the request body.
MAX_CHUNKS = 16


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
        data = await asyncio.wrap_future(
            asyncio.run_coroutine_threadsafe(self._source.read(), self._loop)
        )
        if not data:
            raise StopAsyncIteration
        return data


class UploadStdin:
    """An HTTP upload's stdin part, a few chunks ahead of the line.

    The request reader feeds each chunk as it arrives and waits while
    ``MAX_CHUNKS`` are unread, so a slow line slows the upload instead
    of filling memory. Once the line is done the rest is discarded, so
    the upload can finish and the caller can read the answer.
    """

    def __init__(self) -> None:
        self._queue: asyncio.Queue[bytes] = asyncio.Queue(MAX_CHUNKS)
        self._discarding = False

    async def feed(self, data: bytes) -> None:
        """Queue a chunk of the upload.

        Args:
            data (bytes): the chunk; empty chunks are skipped.
        """
        if data and not self._discarding:
            await self._queue.put(data)

    async def close(self) -> None:
        """Mark the end of the upload."""
        if not self._discarding:
            await self._queue.put(b"")

    def discard(self) -> None:
        """Drop what is queued and everything still to come.

        A reader waiting for the next chunk gets the end instead.
        """
        self._discarding = True
        while not self._queue.empty():
            self._queue.get_nowait()
        self._queue.put_nowait(b"")

    async def read(self) -> bytes:
        """The next chunk.

        Returns:
            bytes: the chunk, or ``b""`` at the end of the upload.
        """
        if self._discarding:
            return b""
        data = await self._queue.get()
        if not data:
            self._queue.put_nowait(b"")
        return data
