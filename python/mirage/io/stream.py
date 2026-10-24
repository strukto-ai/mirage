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
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Generator,
    Iterable,
)
from functools import partial
from typing import Any, Generic, TypeVar, cast

from mirage.concurrency.limiter import settle
from mirage.io import IOResult
from mirage.io.async_line_iterator import SharedInput
from mirage.io.types import ByteSource, materialize  # noqa: F401

logger = logging.getLogger(__name__)
_T = TypeVar("_T")


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


async def close_quietly(stream: bytes | AsyncIterator[_T] | None) -> None:
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


class InlineAwait(Generic[_T]):
    """Await an awaitable inside the awaiting task.

    asyncio runs a coroutine in another context, or lets another task
    cancel it, only through a task of its own, and a task costs two turns
    of the event loop: on a command's output that is most of what one
    write costs. This drives the awaitable's own steps instead and hands
    the event loop each future a step waits on, so the awaiting task waits
    on it directly. ``cancel`` does what cancelling such a task would: it
    cancels the future the step waits on, or throws CancelledError into
    the next step.

    Args:
        awaitable (Awaitable[_T]): what to await, once.
    """

    def __init__(self, awaitable: Awaitable[_T]) -> None:
        self._awaitable = awaitable
        self._waiting: Any = None
        self._cancelling = False
        self._finished = False
        self._ended: asyncio.Future[None] | None = None

    def cancel(self) -> None:
        """Cancel the step in flight, or the next one to run."""
        waiting = self._waiting
        if isinstance(waiting, asyncio.Future) and waiting.cancel():
            return
        self._cancelling = True

    def ended(self) -> asyncio.Future[None]:
        """A future that resolves once the last step has run."""
        if self._ended is None:
            self._ended = asyncio.get_running_loop().create_future()
            if self._finished:
                self._ended.set_result(None)
        return self._ended

    def _step(
        self, steps: Any, value: Any, error: BaseException | None
    ) -> Any:
        if error is not None:
            return steps.throw(error)
        return steps.send(value)

    def __await__(self) -> Generator[Any, None, _T]:
        steps = self._awaitable.__await__()
        value: Any = None
        error: BaseException | None = None
        try:
            while True:
                if self._cancelling and error is None:
                    self._cancelling = False
                    error = asyncio.CancelledError()
                try:
                    yielded = self._step(steps, value, error)
                except StopIteration as stop:
                    return cast(_T, stop.value)
                self._waiting = yielded
                try:
                    value, error = (yield yielded), None
                except GeneratorExit:
                    steps.close()
                    raise
                except BaseException as exc:
                    value, error = None, exc
                finally:
                    self._waiting = None
        finally:
            self._finished = True
            if self._ended is not None and not self._ended.done():
                self._ended.set_result(None)


class OutputStream:
    """Own producer cleanup even when its byte iterator was never started."""

    def __init__(
        self,
        source: AsyncIterator[bytes],
        close: Callable[[], Awaitable[None]],
    ) -> None:
        self._source = source
        self._close = close
        self._pull: InlineAwait[bytes] | None = None
        self._closing: asyncio.Task[None] | None = None

    def __aiter__(self) -> "OutputStream":
        return self

    async def __anext__(self) -> bytes:
        if self._closing is not None:
            raise StopAsyncIteration
        # In the consumer's own task, which a close from another task can
        # still cancel: a task per pull would cost as much as the write.
        pull = InlineAwait(anext(self._source))
        self._pull = pull
        try:
            return await pull
        except BaseException:
            if self._pull is pull:
                self._pull = None
            await self.aclose()
            raise
        finally:
            if self._pull is pull:
                self._pull = None

    async def _finish(self) -> None:
        pull = self._pull
        if pull is not None:
            pull.cancel()
            await settle(pull.ended())
        close = getattr(self._source, "aclose", None)
        try:
            if close is not None:
                await close()
        finally:
            await self._close()

    async def aclose(self) -> None:
        if self._closing is None:
            self._closing = asyncio.create_task(self._finish())
        await settle(self._closing)


async def discard_streams(*streams: ByteSource | None) -> None:
    """Discard failed reads without changing normal early-close behavior."""
    for stream in streams:
        if isinstance(stream, SharedInput):
            await stream.discard()
        else:
            await close_quietly(stream)


async def discard_io(io: IOResult) -> None:
    await discard_streams(io.stdout, io.stderr)


def async_chain(streams: Iterable[ByteSource | None]) -> AsyncIterator[bytes]:
    sources = list(streams)

    async def output() -> AsyncIterator[bytes]:
        for source in sources:
            if source is None:
                continue
            async for part in ensure_stream(source):
                yield part

    async def close() -> None:
        for source in sources:
            await close_quietly(source)

    return OutputStream(output(), close)


async def feed(
    stdin: ByteSource | None,
    write: Callable[[bytes], Awaitable[None]],
    end: Callable[[], Awaitable[None]],
    exited: Callable[[], bool],
    closed: Callable[[Exception], bool] | None = None,
) -> None:
    """Write a program's input as it is read, then end it: a finite
    command waits for that end. A program that ended first, or closed
    its input (a broken pipe, or what ``closed`` says means that), has
    taken what it wanted, so neither fails the run. Mirrors TypeScript's
    ``feed``.

    Args:
        stdin (ByteSource | None): the input; None ends it at once.
        write (Callable[[bytes], Awaitable[None]]): sends one chunk,
            waiting while the program is behind.
        end (Callable[[], Awaitable[None]]): ends the input.
        exited (Callable[[], bool]): whether the program has ended, for
            a cancel that lands after it.
        closed (Callable[[Exception], bool] | None): which other errors
            mean the program closed its input.
    """
    try:
        async for chunk in async_chain([stdin] if stdin is not None else []):
            await write(chunk)
        await end()
    except asyncio.CancelledError:
        if not exited():
            raise
        logger.debug("a program ended before consuming its input")
    except Exception as exc:
        if not isinstance(exc, (BrokenPipeError, ConnectionResetError)) and (
            closed is None or not closed(exc)
        ):
            raise
        logger.debug("a program closed its input: %s", exc)


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


async def prime_stream(
    source: AsyncIterator[bytes],
    failed: Callable[[Exception], None] | None = None,
) -> ByteSource:
    """Open a reader before creating its destination.

    Args:
        source (AsyncIterator[bytes]): the owned reader.
        failed (Callable | None): observes a failure after the first pull.
    """
    try:
        first = await anext(source, b"")
    except BaseException:
        await close_quietly(source)
        raise

    async def rest() -> AsyncIterator[bytes]:
        try:
            if first:
                yield first
            async for chunk in source:
                yield chunk
        except Exception as exc:
            if failed is not None:
                failed(exc)
            raise
        finally:
            await close_quietly(source)

    return OutputStream(rest(), lambda: close_quietly(source))


def slice_stream(
    source: ByteSource, offset: int = 0, size: int | None = None
) -> OutputStream:
    """Take a byte window without materializing its prefix or suffix.

    Args:
        source (ByteSource): input owned by this window.
        offset (int): bytes to skip.
        size (int | None): maximum bytes to yield, None for the remainder.
    """
    if offset < 0 or (size is not None and size < 0):
        raise ValueError("stream window must be nonnegative")

    async def window() -> AsyncIterator[bytes]:
        skipped, remaining = offset, size
        if remaining == 0:
            return
        async for part in ensure_stream(source):
            cut = min(skipped, len(part))
            skipped -= cut
            part = part[cut:]
            if remaining is not None:
                part = part[:remaining]
                remaining -= len(part)
            if part:
                yield part
            if remaining == 0:
                return

    return OutputStream(window(), partial(close_quietly, source))


def rechunk(source: ByteSource, size: int) -> OutputStream:
    """Re-cut a stream into parts of up to ``size`` bytes, joining short
    ones, so a consumer pays once per block rather than once per record.

    Args:
        source (ByteSource): input owned by the result.
        size (int): the largest part.
    """

    async def parts() -> AsyncIterator[bytes]:
        pending = bytearray()
        async for part in ensure_stream(source):
            pending += part
            while len(pending) >= size:
                yield bytes(pending[:size])
                del pending[:size]
        if pending:
            yield bytes(pending)

    return OutputStream(parts(), partial(close_quietly, source))
