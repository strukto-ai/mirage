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

from mirage.io.errors import PipeClosed
from mirage.io.pipe import CAPACITY, BytePipe


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
    """An upload backed by the same bounded byte pipe as process stdin."""

    def __init__(self, capacity: int = CAPACITY) -> None:
        self._pipe = BytePipe(capacity)
        self._reader = self._pipe.stream()
        self._discarding = False

    async def feed(self, data: bytes) -> None:
        """Accept an upload chunk, waiting for byte capacity.

        Args:
            data (bytes): received bytes; empty chunks are skipped.
        """
        if self._discarding:
            return
        try:
            await self._pipe.write(data)
        except PipeClosed:
            if not self._discarding:
                raise

    async def close(self) -> None:
        """Mark the end of the upload."""
        self._pipe.end()

    def discard(self) -> None:
        """Release readers and feeders, dropping unread bytes."""
        self._discarding = True
        self._pipe.close_reader()

    async def read(self) -> bytes:
        """Return the next chunk, or empty bytes once the upload ends."""
        return await anext(self._reader, b"")
