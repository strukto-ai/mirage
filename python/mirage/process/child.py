import asyncio
import logging
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass

from mirage.io.stream import materialize
from mirage.process.handle import ProcessHandle
from mirage.process.stdio import ProcessInput, ProcessOutput
from mirage.process.types import ProcessInfo
from mirage.shell.errors import PipeClosed

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class ProcessResult:
    stdout: bytes
    stderr: bytes
    exit_code: int


class ChildProcess:
    """Async byte streams and a control handle for one admitted execution."""

    def __init__(self, process: ProcessHandle, stdin: ProcessInput,
                 output: ProcessOutput, cancel: Callable[[], None]) -> None:

        def finished(_: asyncio.Task[int]) -> None:
            stdin.stop()
            output.end()

        process.task.add_done_callback(finished)
        self._process = process
        self.stdin = stdin
        self.stdout: AsyncIterator[bytes] = output.stdout.stream()
        self.stderr: AsyncIterator[bytes] = output.stderr.stream()
        self._cancel = cancel

    @property
    def pid(self) -> int:
        return self._process.info.pid

    def terminate(self) -> None:
        self._cancel()

    async def wait(self) -> ProcessInfo:
        return await self._process.join()

    async def communicate(self, data: bytes = b"") -> ProcessResult:

        async def feed() -> None:
            try:
                await self.stdin.write(data)
            except PipeClosed:
                logger.debug("process %d closed stdin", self.pid)
            finally:
                self.stdin.close()

        try:
            _, stdout, stderr, info = await asyncio.gather(
                feed(), materialize(self.stdout), materialize(self.stderr),
                self.wait())
            return ProcessResult(
                stdout, stderr,
                info.exit_code if info.exit_code is not None else 1)
        except BaseException:
            self.terminate()
            raise
