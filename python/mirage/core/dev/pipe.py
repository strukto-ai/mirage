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

from mirage.errors.fs import ebadf
from mirage.io.pipe import BytePipe
from mirage.types import PathSpec


class DevicePipe:
    """One directional virtual descriptor with bounded producer backpressure."""

    def __init__(self, readable: bool) -> None:
        self.readable = readable
        self.pipe = BytePipe()
        self._source: AsyncIterator[bytes] | None = None
        self._pending = b""

    async def write(self, data: bytes, path: PathSpec) -> None:
        if self.readable:
            raise ebadf(path)
        await self.pipe.write(data)

    async def read(self, path: PathSpec, size: int | None = None) -> bytes:
        if not self.readable:
            raise ebadf(path)
        if self._source is None:
            self._source = self.pipe.stream()
        chunks: list[bytes] = []
        remaining = size
        while remaining is None or remaining > 0:
            if not self._pending:
                try:
                    self._pending = await anext(self._source)
                except StopAsyncIteration:
                    break
            count = (
                len(self._pending)
                if remaining is None
                else min(remaining, len(self._pending))
            )
            chunks.append(self._pending[:count])
            self._pending = self._pending[count:]
            if remaining is not None:
                remaining -= count
        return b"".join(chunks)

    async def stream(self, path: PathSpec) -> AsyncIterator[bytes]:
        if not self.readable:
            raise ebadf(path)
        if self._source is None:
            self._source = self.pipe.stream()
        try:
            if self._pending:
                pending, self._pending = self._pending, b""
                yield pending
            async for chunk in self._source:
                yield chunk
        finally:
            self.pipe.release()
