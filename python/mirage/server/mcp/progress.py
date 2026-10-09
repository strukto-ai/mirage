import asyncio
import codecs
import time
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

import anyio

from mirage.concurrency.limiter import settle
from mirage.io.types import IOResult, OutputEvent, StreamName
from mirage.workspace.tools.io_text import io_to_str
from mirage.workspace.tools.tool_operations import (
    MirageToolOperations,
    ToolResult,
)
from mirage.workspace.workspace import Session, Workspace

if TYPE_CHECKING:
    from mirage.workspace.shell_execution import ShellExecution

LIMIT = 2048
INTERVAL = 0.25


class OutputProgress:
    """Request-local, bounded text previews; the final result keeps all output."""

    def __init__(self, send: Callable[[float, str], Awaitable[None]]) -> None:
        self._send = send
        self._loop = asyncio.get_running_loop()
        self._pending: dict[StreamName, str] = {"stdout": "", "stderr": ""}
        self._decoders = {
            stream: codecs.getincrementaldecoder("utf-8")("replace")
            for stream in self._pending
        }
        self._last = float("-inf")
        self._progress = 0
        self._lock = asyncio.Lock()
        self._timer: asyncio.Task[None] | None = None
        self._failure: Exception | None = None
        self._cancel: Callable[[], None] | None = None
        self._closed = False
        self._delivering = False

    def bind(self, cancel: Callable[[], None]) -> None:
        self._cancel = cancel

    def _schedule(self) -> None:
        if (
            not self._closed
            and self._timer is None
            and any(self._pending.values())
        ):
            self._timer = asyncio.create_task(self._trailing())

    async def _trailing(self) -> None:
        try:
            await asyncio.sleep(
                max(0, INTERVAL - (time.monotonic() - self._last))
            )
            self._delivering = True
            await self.flush()
        except Exception as error:
            self._failure = error
            if self._cancel is not None:
                self._cancel()
        finally:
            self._timer = None
            self._delivering = False
            if self._failure is None:
                self._schedule()

    def _append(self, stream: StreamName, text: str) -> None:
        joined = self._pending[stream] + text
        self._pending[stream] = (
            joined if len(joined) <= LIMIT else "…" + joined[-(LIMIT - 1) :]
        )

    async def feed(self, stream: StreamName, data: bytes) -> None:
        if self._failure is not None:
            raise self._failure
        self._append(stream, self._decoders[stream].decode(data))
        if time.monotonic() - self._last >= INTERVAL:
            await self.flush()
        self._schedule()

    async def _notify(self, value: float, message: str) -> None:
        await self._send(value, message)

    async def flush(self) -> None:
        async with self._lock:
            for stream, text in self._pending.items():
                if not text:
                    continue
                self._pending[stream] = ""
                self._last = time.monotonic()
                self._progress += 1
                notification = self._notify(
                    self._progress, f"[{stream}] {text}"
                )
                if asyncio.get_running_loop() is self._loop:
                    await notification
                else:
                    await asyncio.wrap_future(
                        asyncio.run_coroutine_threadsafe(
                            notification, self._loop
                        )
                    )

    async def close(self) -> None:
        self._closed = True
        if self._timer is not None:
            if not self._delivering:
                self._timer.cancel()
            await asyncio.gather(self._timer, return_exceptions=True)
        if self._failure is not None:
            raise self._failure

    async def finish(self) -> None:
        await self.close()
        for stream, decoder in self._decoders.items():
            self._append(stream, decoder.decode(b"", final=True))
        await self.flush()


async def collect_execution(
    execution: "ShellExecution", progress: OutputProgress | None = None
) -> IOResult:
    """Drain one SDK execution, preserving its full tool result and cleanup.

    Args:
        execution (ShellExecution): The owned shell execution.
        progress (OutputProgress | None): Request-local preview delivery.
    """
    if progress is None:
        return await execution.collect()
    progress.bind(execution.cancel)

    async def preview(event: OutputEvent) -> None:
        await progress.feed(event.stream, event.data)

    try:
        result = await execution.collect(preview)
        await progress.finish()
        return result
    finally:
        with anyio.CancelScope(shield=True):
            await settle(asyncio.create_task(progress.close()))


class McpToolOperations(MirageToolOperations):
    """The ordinary tool table with SDK streaming for shell calls."""

    def __init__(
        self,
        workspace: Workspace,
        session_id: str | None = None,
        stale_write_protection: bool = True,
    ) -> None:
        super().__init__(
            Session(workspace, session_id),
            stale_write_protection=stale_write_protection,
        )
        self._workspace = workspace
        self._mcp_session_id = session_id

    async def shell(
        self, command: str, progress: OutputProgress | None = None
    ) -> ToolResult:
        execution = await self._workspace.shell(
            command, session_id=self._mcp_session_id, stream=True
        )
        result = await collect_execution(execution, progress)
        return ToolResult(io_to_str(result), result.exit_code != 0)
