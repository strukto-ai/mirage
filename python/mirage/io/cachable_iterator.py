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
        try:
            chunk = await self._source.__anext__()
        except StopAsyncIteration:
            self._exhausted = True
            raise
        self._buffer.append(chunk)
        return chunk

    async def drain(self) -> bytes:
        """Consume remaining chunks and return all accumulated bytes."""
        try:
            async for chunk in self._source:
                self._buffer.append(chunk)
        finally:
            self._exhausted = True
        return b"".join(self._buffer)

    async def drain_bounded(self, max_bytes: int) -> bytes | None:
        """Drain remaining chunks but stop if buffer exceeds max_bytes.

        Returns the accumulated bytes when fully drained. When the
        budget is exceeded, closes the source, releases the partial
        buffer, and returns None.
        """
        total = sum(len(c) for c in self._buffer)
        try:
            if total > max_bytes:
                await self._close_and_discard()
                return None
            async for chunk in self._source:
                self._buffer.append(chunk)
                total += len(chunk)
                if total > max_bytes:
                    await self._close_and_discard()
                    return None
        finally:
            self._exhausted = True
        return b"".join(self._buffer)

    async def _close_and_discard(self) -> None:
        self._buffer.clear()
        await self._close_source()

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
