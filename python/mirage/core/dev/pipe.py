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
import weakref
from collections.abc import AsyncIterator

from mirage.errors.fs import ebadf
from mirage.io.pipe import BytePipe
from mirage.io.types import PipeStream
from mirage.types import PathSpec


class DevicePipe:
    """One directional virtual descriptor with bounded producer backpressure.

    The read end belongs to the scope that opened the descriptor, which
    closes it with ``pipe.close_reader()`` when its command ends, unless a
    descriptor the shell still holds reads the rest first, and closes the
    streams readers opened on it that are still open (``readers``, held
    weakly); no reader closes it, so a function can read one substitution
    twice. Readers take turns, one chunk each, so concurrent readers split
    the stream between them and a ranged read leaves the rest of its chunk
    to the next reader. A chunk is pulled in a task of its own: a reader
    cancelled while it waits leaves that chunk to the next reader rather
    than ending the stream for every reader.
    """

    def __init__(self, readable: bool) -> None:
        self.readable = readable
        self.pipe = BytePipe()
        self._source: AsyncIterator[bytes] | None = None
        self._pull: asyncio.Task[bytes] | None = None
        self._pending = b""
        self._turn = asyncio.Lock()
        self.readers: weakref.WeakSet[PipeStream] = weakref.WeakSet()

    async def write(self, data: bytes, path: PathSpec) -> None:
        if self.readable:
            raise ebadf(path)
        await self.pipe.write(data)

    async def read(self, path: PathSpec, size: int | None = None) -> bytes:
        if not self.readable:
            raise ebadf(path)
        chunks: list[bytes] = []
        remaining = size
        while remaining is None or remaining > 0:
            chunk = await self._take(remaining)
            if not chunk:
                break
            chunks.append(chunk)
            if remaining is not None:
                remaining -= len(chunk)
        return b"".join(chunks)

    async def stream(self, path: PathSpec) -> AsyncIterator[bytes]:
        if not self.readable:
            raise ebadf(path)
        while chunk := await self._take(None):
            yield chunk

    async def _take(self, size: int | None) -> bytes:
        """One reader's turn: the next bytes of the stream, b"" at its end.

        Args:
            size (int | None): the most bytes to take; None takes what is
                left of the current chunk.
        """
        async with self._turn:
            if not self._pending:
                pull = self._pull or asyncio.create_task(self._next())
                self._pull = pull
                try:
                    await asyncio.shield(pull)
                finally:
                    if pull.done() and (pull.cancelled() or pull.exception()):
                        self._pull = None
                self._pull = None
                self._pending = pull.result()
            count = (
                len(self._pending)
                if size is None
                else min(size, len(self._pending))
            )
            taken, self._pending = (
                self._pending[:count],
                self._pending[count:],
            )
            return taken

    async def _next(self) -> bytes:
        if self._source is None:
            self._source = self.pipe.stream()
        return await anext(self._source, b"")
