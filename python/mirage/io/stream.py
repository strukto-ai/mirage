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
from collections.abc import AsyncIterator, Iterable

from mirage.io import IOResult
from mirage.io.async_line_iterator import SharedInput
from mirage.io.types import ByteSource, materialize  # noqa: F401

logger = logging.getLogger(__name__)


class SharedStdin:
    """One lazy byte cursor shared by commands inheriting an input descriptor.

    Reads are serialized, including source pulls, so concurrent consumers
    neither replay bytes nor advance the source simultaneously. A consumer
    stopping early leaves the cursor open for the next one. Byte-sized pulls
    preserve the unread suffix when a command such as ``head -c 1`` exits.

    Args:
        source (ByteSource): the inherited input, still unread.
    """

    def __init__(self, source: ByteSource) -> None:
        self._chunks: AsyncIterator[bytes] | None = ensure_stream(source)
        self._buffer = b""
        self._pos = 0
        self._lock = asyncio.Lock()

    def __aiter__(self) -> "SharedStdin":
        return self

    async def __anext__(self) -> bytes:
        async with self._lock:
            while self._pos >= len(self._buffer):
                if self._chunks is None:
                    raise StopAsyncIteration
                try:
                    self._buffer = await anext(self._chunks)
                except StopAsyncIteration:
                    self._chunks = None
                    raise
                self._pos = 0
            chunk = self._buffer[self._pos : self._pos + 1]
            self._pos += 1
            return chunk


async def drain(stream: ByteSource | None) -> None:
    if stream is None or isinstance(stream, bytes):
        return
    async for _ in stream:
        pass


async def close_quietly(stream: ByteSource | None) -> None:
    """Best-effort close on an async generator stream.

    Calls the underlying Python `aclose()` protocol. Ensures VFS
    cleanup (HTTP connections, file handles) fires promptly instead of
    waiting for GC. Harmless on exhausted streams and on bytes/None.
    """
    if stream is None or isinstance(stream, bytes):
        return
    closer = getattr(stream, "aclose", None)
    if closer is None:
        return
    try:
        await closer()
    except Exception as exc:
        # closing a drained stream is cleanup; failures must not mask the
        # consumer's own result
        logger.debug("stream closer failed: %s", exc)


async def discard_streams(*streams: ByteSource | None) -> None:
    """Discard failed reads without changing normal early-close behavior."""
    for stream in streams:
        if isinstance(stream, SharedInput):
            await stream.discard()
        else:
            await close_quietly(stream)


async def discard_io(io: IOResult) -> None:
    await discard_streams(io.stdout, io.stderr)


async def async_chain(
    streams: Iterable[ByteSource | None],
) -> AsyncIterator[bytes]:
    for stream in streams:
        if stream is None:
            continue
        if isinstance(stream, bytes):
            if stream:
                yield stream
        else:
            try:
                async for chunk in stream:
                    yield chunk
            finally:
                await close_quietly(stream)


async def yield_bytes(data: bytes) -> AsyncIterator[bytes]:
    yield data


def ensure_stream(src: ByteSource) -> AsyncIterator[bytes]:
    """Present a byte source as a stream.

    An iterator is returned as itself, so closing the consumer closes
    its source; bytes become a one-chunk stream.

    Args:
        src (ByteSource): Bytes or an async byte iterator.

    Returns:
        AsyncIterator[bytes]: ``src`` itself, or ``yield_bytes(src)``.
    """
    return yield_bytes(src) if isinstance(src, bytes) else src
