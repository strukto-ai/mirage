import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass

from mirage.concurrency.limiter import settle
from mirage.io.cooperative import chunks
from mirage.io.output import OutputPipe
from mirage.io.pipe import CAPACITY
from mirage.io.stream import close_quietly, wrap_cachable_streams
from mirage.io.types import (
    ByteSource,
    CommandOutput,
    HandlerResult,
    IOResult,
    OutputState,
    StreamName,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class ByteWriter:
    """An asynchronous byte destination owned by its invocation."""

    write: Callable[[bytes], Awaitable[None]]


class Stdio:
    """A handler's input, asynchronous output, and cancellation lifetime."""

    def __init__(
        self, stdin: ByteSource | None = None, buffer_bytes: int = CAPACITY
    ) -> None:
        self.stdin = chunks(stdin if stdin is not None else b"")
        self._pipe = OutputPipe(buffer_bytes)
        self._published = asyncio.Event()
        self._writing = False
        self._cancelled = asyncio.Event()
        self.stdout = ByteWriter(self._stdout)
        self.stderr = ByteWriter(self._stderr)

    @property
    def cancelled(self) -> bool:
        return self._cancelled.is_set()

    async def wait_cancelled(self) -> None:
        await self._cancelled.wait()

    async def _stdout(self, data: bytes) -> None:
        await self._write("stdout", data)

    async def _stderr(self, data: bytes) -> None:
        await self._write("stderr", data)

    async def _write(self, stream: StreamName, data: bytes) -> None:
        if not data:
            return
        self._writing = True
        self._published.set()
        await self._pipe.write(stream, data)

    def _cancel(self) -> None:
        self._cancelled.set()
        self._pipe.close_reader()


class OutputStream:
    """Own producer cleanup even when its byte iterator was never started."""

    def __init__(
        self,
        source: AsyncIterator[bytes],
        close: Callable[[], Awaitable[None]],
    ) -> None:
        self._source = source
        self._close = close
        self._pull: asyncio.Future[bytes] | None = None
        self._closing: asyncio.Task[None] | None = None

    def __aiter__(self) -> "OutputStream":
        return self

    async def __anext__(self) -> bytes:
        if self._closing is not None:
            raise StopAsyncIteration
        pull = asyncio.ensure_future(anext(self._source))
        self._pull = pull
        try:
            return await pull
        finally:
            if self._pull is pull:
                self._pull = None

    async def _finish(self) -> None:
        pull = self._pull
        if pull is not None and not pull.done():
            pull.cancel()
            try:
                await settle(pull)
            except asyncio.CancelledError:
                logger.debug("closing an active handler output pull")
            except Exception:
                logger.debug(
                    "handler output pull failed during close", exc_info=True
                )
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


def _copy_result(io: IOResult, outcome: IOResult) -> None:
    io._stream_source = outcome
    io.reads.update(outcome.reads)
    io.writes.update(outcome.writes)
    io.cache[:] = outcome.cache
    io.matched_runs = outcome.matched_runs
    io.sized_runs = outcome.sized_runs
    io.counted_runs = outcome.counted_runs
    io.refusal = outcome.refusal


async def invoke(
    run: Callable[[Stdio], Awaitable[HandlerResult]],
    stdin: ByteSource | None = None,
    *,
    buffer_bytes: int = CAPACITY,
) -> CommandOutput | None:
    """Publish one admitted handler and own all of its output and cleanup.

    Args:
        run (Callable): admitted handler, in its existing session and scope.
        stdin (ByteSource | None): input inherited by this invocation.
        buffer_bytes (int): maximum bytes retained by the output pipe.
    """
    stdio = Stdio(stdin, buffer_bytes)
    io = IOResult()
    state = OutputState()
    io.output = state
    reading = asyncio.Event()
    declined = False
    failure: BaseException | None = None

    async def pump(stream: StreamName, returned: ByteSource) -> None:
        iterator = chunks(returned)
        try:
            async for data in iterator:
                await stdio._pipe.write(stream, data)
                await stdio._pipe.drain()
                if stdio.cancelled:
                    return
        finally:
            await close_quietly(iterator)

    async def produce() -> None:
        nonlocal declined, failure
        source: ByteSource | None = None
        stderr: ByteSource | None = None
        outcome: IOResult | None = None
        stderr_started = False
        try:
            result = await run(stdio)
            declined = result is None and not stdio._writing
            source, outcome = (
                (result.stdout, result)
                if isinstance(result, IOResult)
                else result
                if result is not None
                else (None, IOResult())
            )
            source, outcome = wrap_cachable_streams(source, outcome)
            stderr = outcome.stderr
            _copy_result(io, outcome)
            if (source is None or isinstance(source, bytes)) and (
                stderr is None or isinstance(stderr, bytes)
            ):
                await close_quietly(stdio.stdin)
            stdio._published.set()
            if source is not None or stderr is not None:
                await reading.wait()
                streams: tuple[StreamName, ...] = ("stdout", "stderr")
                for stream in streams:
                    returned = source if stream == "stdout" else outcome.stderr
                    if stream == "stderr":
                        stderr_started = True
                        stderr = returned
                    if returned is None:
                        continue
                    await pump(stream, returned)
                    if stdio.cancelled:
                        return
            _copy_result(io, outcome)
            state.finish()
            stdio._pipe.end()
        except BaseException as exc:
            if (
                outcome is not None
                and not isinstance(exc, asyncio.CancelledError)
                and not stderr_started
                and stdio._published.is_set()
                and not stdio.cancelled
            ):
                stderr = outcome.stderr
                if stderr is not None:
                    stderr_started = True
                    try:
                        await pump("stderr", stderr)
                    except Exception:
                        logger.debug(
                            "handler stderr failed after stdout", exc_info=True
                        )
            if not stdio._published.is_set():
                failure = exc
            stdio._pipe.end(exc)
            raise
        finally:
            await close_quietly(source)
            await close_quietly(stderr)
            await close_quietly(stdio.stdin)
            if outcome is not None and not state.settled:
                if (
                    stdio.cancelled
                    and not stderr_started
                    and isinstance(outcome.stderr, bytes)
                ):
                    io.stderr = await io.materialize_stderr() + outcome.stderr
                _copy_result(io, outcome)
                state.finish()
            stdio._published.set()

    task = asyncio.create_task(produce())

    async def close() -> None:
        stdio._cancel()
        if not task.done():
            task.cancel()
        try:
            await settle(task)
        except asyncio.CancelledError:
            logger.debug("handler cancelled after reader closed")
        except Exception:
            logger.debug("handler failed while closing output", exc_info=True)
        await close_quietly(stdio.stdin)

    try:
        await stdio._published.wait()
        if failure is not None:
            raise failure
        if declined:
            await task
            return None
    except BaseException:
        await close()
        raise

    async def output() -> AsyncIterator[bytes]:
        stderr: list[bytes] = []
        reading.set()
        try:
            async for event in stdio._pipe.events():
                if event.stream == "stderr":
                    if state.stderr is not None:
                        await state.stderr(event.data)
                    else:
                        stderr.append(event.data)
                else:
                    yield event.data
            await task
        finally:
            if stderr:
                io.stderr = await io.materialize_stderr() + b"".join(stderr)
            await close()

    return OutputStream(output(), close), io
