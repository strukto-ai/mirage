import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from copy import copy
from types import TracebackType

from mirage.concurrency.limiter import settle
from mirage.io.output import OutputPipe
from mirage.io.pipe import CAPACITY
from mirage.io.types import IOResult, OutputEvent
from mirage.shell.console.job_console import JobConsole
from mirage.shell.console.types import Channel
from mirage.utils.abort import MirageAbortError
from mirage.workspace.execution import ExecutionScope

logger = logging.getLogger(__name__)


class ShellOutput(JobConsole):
    def __init__(self, buffer_bytes: int) -> None:
        super().__init__()
        self.pipe = OutputPipe(buffer_bytes)

    async def emit(self, channel: Channel, data: bytes) -> None:
        if channel == Channel.CONTROL:
            return
        await self.pipe.write(
            "stdout" if channel == Channel.STDOUT else "stderr", data
        )


class ShellEvents(AsyncIterator[OutputEvent]):
    def __init__(self, owner: "ShellExecution", output: ShellOutput) -> None:
        self._owner = owner
        self._output = output
        self._source = output.pipe.events()
        self._pull: asyncio.Task[OutputEvent] | None = None
        self._ended = False

    async def __anext__(self) -> OutputEvent:
        if self._ended:
            raise StopAsyncIteration
        if self._pull is not None:
            raise RuntimeError("shell events already have a pending reader")
        self._pull = asyncio.create_task(anext(self._source))
        try:
            event = await self._pull
            if self._ended:
                raise StopAsyncIteration
            return event
        except StopAsyncIteration:
            self._ended = True
            raise
        except BaseException:
            self._owner.cancel()
            raise
        finally:
            self._pull = None

    async def aclose(self) -> None:
        await self._owner.aclose()

    async def release(self) -> None:
        self._ended = True
        self._output.pipe.close_reader()
        if self._pull is not None:
            await asyncio.gather(self._pull, return_exceptions=True)
        await self._source.aclose()


class ShellExecution:
    """One running shell invocation and its bounded, single-reader output.

    Consume ``events`` before awaiting ``wait``: an unread bounded queue
    backpressures execution. Its capacity defaults to 64 KiB.
    Use ``async with`` when leaving iteration early.
    Closing joins the invocation under the shell's normal cancellation policy.
    """

    def __init__(
        self,
        run: Callable[
            [JobConsole, asyncio.Event, ExecutionScope], Awaitable[IOResult]
        ],
        scope: ExecutionScope,
        cancel: asyncio.Event | None = None,
        *,
        buffer_bytes: int = CAPACITY,
    ) -> None:
        self._cancel = asyncio.Event()
        self._output = ShellOutput(buffer_bytes)
        self.events = ShellEvents(self, self._output)
        self._closing: asyncio.Task[None] | None = None
        self._task = asyncio.create_task(self._run(run, scope, cancel))
        self._task.add_done_callback(self._observed)

    def on_settled(self, callback: Callable[[], None]) -> None:
        """Register the workspace's invocation-release hook."""

        def release(task: asyncio.Task[IOResult]) -> None:
            callback()

        self._task.add_done_callback(release)

    @staticmethod
    def _observed(task: asyncio.Task[IOResult]) -> None:
        if not task.cancelled():
            task.exception()

    async def _run(
        self,
        run: Callable[
            [JobConsole, asyncio.Event, ExecutionScope], Awaitable[IOResult]
        ],
        scope: ExecutionScope,
        external: asyncio.Event | None,
    ) -> IOResult:
        watcher = (
            asyncio.create_task(self._watch(external))
            if external is not None
            else None
        )
        try:
            if self._cancel.is_set() or (
                external is not None and external.is_set()
            ):
                raise MirageAbortError()
            result = await run(self._output, self._cancel, scope)
            self._output.pipe.end()
            return result
        except BaseException as error:
            failure = MirageAbortError() if self._cancel.is_set() else error
            self._output.pipe.end(failure)
            raise failure
        finally:
            if watcher is not None:
                watcher.cancel()
                await asyncio.gather(watcher, return_exceptions=True)

    async def _watch(self, external: asyncio.Event) -> None:
        await external.wait()
        self.cancel()

    def cancel(self) -> None:
        """Request cancellation; accepted output remains readable."""
        if not self._task.done():
            self._cancel.set()
            self._output.pipe.end(MirageAbortError())

    async def wait(self) -> IOResult:
        """Join execution and return final metadata with empty output."""
        return await asyncio.shield(self._task)

    async def collect(
        self,
        on_event: Callable[[OutputEvent], Awaitable[None]] | None = None,
    ) -> IOResult:
        """Collect output and await an optional observer before the next pull.

        Args:
            on_event (Callable[[OutputEvent], Awaitable[None]] | None):
                An asynchronous callback for each ordered output event.
        """
        stdout: list[bytes] = []
        stderr: list[bytes] = []
        async with self:
            async for event in self.events:
                (stdout if event.stream == Channel.STDOUT else stderr).append(
                    event.data
                )
                if on_event is not None:
                    await on_event(event)
            result = copy(await self.wait())
            result.stdout = b"".join(stdout)
            result.stderr = b"".join(stderr) if stderr else None
            return result

    async def _close(self) -> None:
        self.cancel()
        await self.events.release()
        try:
            await self.wait()
        except (MirageAbortError, asyncio.CancelledError):
            logger.debug("shell execution closed after cancellation")
        except Exception:
            logger.debug("shell execution closed after failure", exc_info=True)
        finally:
            await self._output.close()

    async def aclose(self) -> None:
        """Discard unread output, cancel execution and join its cleanup."""
        if self._closing is None:
            self._closing = asyncio.create_task(self._close())
        await settle(self._closing)

    async def __aenter__(self) -> "ShellExecution":
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.aclose()
