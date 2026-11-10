import asyncio
import logging
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass

from mirage.execution.process.handle import ProcessHandle
from mirage.execution.process.stdio import ProcessInput, ProcessOutput
from mirage.execution.process.types import Process
from mirage.io.stream import materialize
from mirage.shell.errors import PipeClosed

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class ProcessResult:
    stdout: bytes
    stderr: bytes
    exit_code: int


class ChildProcess:
    """Async byte streams and a control handle for one admitted execution."""

    def __init__(
        self,
        process: ProcessHandle,
        stdin: ProcessInput,
        output: ProcessOutput,
        cancel: Callable[[int], None],
    ) -> None:
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
        return self._process.record.pid

    def poll(self) -> int | None:
        return self._process.record.exit

    def terminate(self, signal: int = 9) -> None:
        """Stop the child with ``signal``; its status is 128 plus it.

        Args:
            signal (int): what the stop stands for, KILL (9) unless the
                caller names another (``Popen.terminate`` sends TERM).
        """
        self._cancel(signal)

    async def wait(self) -> Process:
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
            _, stdout, stderr, record = await asyncio.gather(
                feed(),
                materialize(self.stdout),
                materialize(self.stderr),
                self.wait(),
            )
            return ProcessResult(
                stdout,
                stderr,
                record.exit if record.exit is not None else 1,
            )
        except BaseException:
            self.terminate()
            raise
