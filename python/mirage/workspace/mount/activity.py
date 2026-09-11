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
from collections.abc import AsyncIterator, Callable

from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.io.types import ByteSource


class ResourceActivity:
    """Calls and streams sharing a resource, including removed aliases."""

    def __init__(self) -> None:
        self._count = 0
        self._idle = asyncio.Event()
        self._idle.set()

    def acquire(self) -> Callable[[], None]:
        self._count += 1
        self._idle.clear()
        released = False

        def release() -> None:
            nonlocal released
            if released:
                return
            released = True
            self._count -= 1
            if self._count == 0:
                self._idle.set()

        return release

    async def wait(self) -> None:
        await self._idle.wait()

    def hold(self, source: ByteSource) -> ByteSource:
        if isinstance(source, (bytes, bytearray)):
            return source
        if isinstance(source, CachableAsyncIterator):
            if source.exhausted:
                return source
            source.replace_source(ActivityStream(source.source,
                                                 self.acquire()))
            return source
        return ActivityStream(source, self.acquire())


class ActivityStream:
    """Release a stream's resource on EOF, error, or explicit close."""

    def __init__(self, source: AsyncIterator[bytes],
                 release: Callable[[], None]) -> None:
        self._source = source.__aiter__()
        self._release = release
        self._pull_lock = asyncio.Lock()

    def __aiter__(self) -> "ActivityStream":
        return self

    async def __anext__(self) -> bytes:
        async with self._pull_lock:
            try:
                return await self._source.__anext__()
            except BaseException:
                self._release()
                raise

    async def aclose(self) -> None:
        async with self._pull_lock:
            try:
                close = getattr(self._source, "aclose", None)
                if close is not None:
                    await close()
            finally:
                self._release()
