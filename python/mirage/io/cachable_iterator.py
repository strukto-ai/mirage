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

import logging
from collections.abc import AsyncIterator

from mirage.io.yield_budget import YieldBudget

logger = logging.getLogger(__name__)


class CachableAsyncIterator:
    """Wraps AsyncIterator[bytes], buffers chunks as consumed.

    Drains remainder on request.

    Args:
        source (AsyncIterator[bytes]): The underlying async byte iterator.
    """

    def __init__(self, source: AsyncIterator[bytes]) -> None:
        self._source = source
        self._buffer: list[bytes] = []
        self._exhausted = False
        self._discarded = False
        self._budget = YieldBudget()

    @property
    def discarded(self) -> bool:
        return self._discarded

    @property
    def exhausted(self) -> bool:
        """Whether the underlying source iterator is fully consumed."""
        return self._exhausted

    @property
    def buffered_chunks(self) -> list[bytes]:
        """Chunks consumed from the source so far. Do not mutate."""
        return self._buffer

    @property
    def source(self) -> AsyncIterator[bytes]:
        """Underlying iterator used by mount-context wrappers."""
        return self._source

    def replace_source(self, source: AsyncIterator[bytes]) -> None:
        """Replace the source before iteration starts.

        Args:
            source (AsyncIterator[bytes]): Context-wrapped source iterator.
        """
        if self._buffer or self._exhausted:
            raise RuntimeError(
                "cannot replace a started cache iterator source")
        self._source = source

    def __aiter__(self) -> "CachableAsyncIterator":
        return self

    async def __anext__(self) -> bytes:
        if self._exhausted:
            raise StopAsyncIteration
        try:
            await self._budget.run()
            chunk = await self._source.__anext__()
        except StopAsyncIteration:
            self._exhausted = True
            raise
        except BaseException:
            await self.discard()
            raise
        self._buffer.append(chunk)
        return chunk

    async def drain(self) -> bytes:
        """Consume remaining chunks and return all accumulated bytes."""
        if self._exhausted:
            return b"".join(self._buffer)
        try:
            async for chunk in self._source:
                await self._budget.run()
                self._buffer.append(chunk)
        except BaseException:
            await self.discard()
            raise
        finally:
            self._exhausted = True
        return b"".join(self._buffer)

    async def drain_bounded(self, max_bytes: int) -> bytes | None:
        """Drain remaining chunks but stop if buffer exceeds max_bytes.

        Returns the accumulated bytes when fully drained. When the
        budget is exceeded, closes the source, releases the partial
        buffer, and returns None.
        """
        if self._discarded:
            return None
        total = sum(len(c) for c in self._buffer)
        try:
            if total > max_bytes:
                await self.discard()
                return None
            async for chunk in self._source:
                await self._budget.run()
                self._buffer.append(chunk)
                total += len(chunk)
                if total > max_bytes:
                    await self.discard()
                    return None
        except BaseException:
            await self.discard()
            raise
        finally:
            self._exhausted = True
        return b"".join(self._buffer)

    async def discard(self) -> None:
        """Discard failed content, leaving normal early exits drainable."""
        if self._discarded:
            return
        self._discarded = True
        self._exhausted = True
        self._buffer.clear()
        try:
            await self._close_source()
        except Exception as exc:
            # The consumer's own error is the one to report.
            logger.debug("discarded source closer failed: %s", exc)

    async def _close_source(self) -> None:
        """Close the underlying source iterator if it supports aclose.

        Deliberately NOT named ``aclose``: pipes.py close_quietly duck-
        types on that name for SIGPIPE-style teardown, and it must keep
        no-opping on this wrapper so an early-exiting consumer (``cat x
        | head``) leaves the source open for the background cache drain.
        """
        close = getattr(self._source, "aclose", None)
        if close is not None:
            await close()
