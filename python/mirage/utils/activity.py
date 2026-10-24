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
from collections.abc import AsyncIterator, Callable

from mirage.concurrency.limiter import owned_task, settle
from mirage.io.types import ByteSource

logger = logging.getLogger(__name__)


class Activity:
    """Work in flight on one resource, awaited before it is released."""

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
        """Count ``source`` in flight until it ends or is closed."""
        if isinstance(source, (bytes, bytearray)):
            return source
        return ActivityStream(source, self.acquire())


class ActivityStream:
    """Release a stream's resource on EOF, error, or explicit close."""

    def __init__(
        self, source: AsyncIterator[bytes], release: Callable[[], None]
    ) -> None:
        self._source = source.__aiter__()
        self._release = release
        self._pull_lock = asyncio.Lock()
        self._closing: asyncio.Task[None] | None = None

    def __aiter__(self) -> "ActivityStream":
        return self

    async def __anext__(self) -> bytes:
        async with self._pull_lock:
            if self._closing is not None:
                raise StopAsyncIteration
            try:
                return await self._source.__anext__()
            except BaseException:
                if self._closing is None:
                    self._release()
                raise

    async def aclose(self) -> None:
        if self._closing is None:
            self._closing = owned_task(self._finish())
        await settle(self._closing)

    async def _finish(self) -> None:
        """Wake close-driven readers; native generators require an idle pull.

        Keep the activity until both the pull and source cleanup have ended.
        """
        close = getattr(self._source, "aclose", None)
        try:
            if close is not None:
                try:
                    await close()
                except RuntimeError as exc:
                    if (
                        str(exc)
                        != "aclose(): asynchronous generator is already running"
                    ):
                        raise
                    logger.debug(
                        "waiting for generator pull before close",
                        exc_info=True,
                    )
                    async with self._pull_lock:
                        await close()
        finally:
            async with self._pull_lock:
                self._release()
