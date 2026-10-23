import asyncio
import logging
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import replace
from threading import RLock

from mirage.context.session_context import run_with_execution
from mirage.process.types import ProcessInfo, ProcessRunner, ProcessState

logger = logging.getLogger(__name__)


class ProcessHandle:
    """Host-side lifecycle of one asynchronous runner.

    Termination requests cancellation once, standing for a signal: a
    native program the runner started receives it, and a cancelled
    runner's status is 128 plus it, as a shell reports a child the
    signal ended. Joining waits for the runner, including its finally
    blocks; it does not assert that a provider has stopped native
    descendants. A cancelled waiter never cancels the runner.
    """

    def __init__(
        self,
        info: ProcessInfo,
        run: ProcessRunner,
        finished: Callable[[int], None],
        cancel_children: Callable[[int], None] = lambda signal: None,
    ) -> None:
        self._info = info
        self._lock = RLock()
        self._finished = finished
        self._cancel_children = cancel_children
        self._signal: int | None = None
        self._program_code: int | None = None
        self._completion: Future[ProcessInfo] = Future()
        self.task = asyncio.create_task(
            run_with_execution(info.execution_id, run, self)
        )
        self.task.add_done_callback(self._settle)

    @property
    def info(self) -> ProcessInfo:
        with self._lock:
            return self._info

    @property
    def signal(self) -> int | None:
        """The signal the runner was stopped with, None while it runs."""
        with self._lock:
            return self._signal

    @property
    def program_code(self) -> int | None:
        """The status a program the runner started exited with on its
        own after the stop signal, None unless one did."""
        with self._lock:
            return self._program_code

    def program_exited(self, code: int) -> None:
        """Record that a program the runner started handled the stop
        signal and exited: a job that is that one program reports its
        status, as bash reports a child that handled the signal.

        Args:
            code (int): the program's exit status.
        """
        with self._lock:
            self._program_code = code

    def terminate(self, signal: int = 9) -> bool:
        """Request cancellation without waiting for the runner to exit.

        Args:
            signal (int): what the stop stands for, KILL (9) unless a
                ``kill`` named another.
        """
        with self._lock:
            if (
                self._info.state == ProcessState.EXITED
                or self._info.cancellation_requested
            ):
                return False
            self._signal = signal
            self.task.get_loop().call_soon_threadsafe(self.task.cancel)
            self._info = replace(
                self._info,
                state=ProcessState.STOPPING,
                cancellation_requested=True,
            )
        self._cancel_children(signal)
        return True

    def _settle(self, task: asyncio.Task[int]) -> None:
        cancelled = task.cancelled()
        error = None if cancelled else task.exception()
        if error is not None:
            logger.debug("process %d failed: %s", self._info.pid, error)
        if cancelled:
            code = 128 + (self._signal or 9)
        else:
            code = 1 if error is not None else task.result()
        with self._lock:
            self._info = replace(
                self._info,
                state=ProcessState.EXITED,
                exit_code=code,
                cancellation_requested=self._info.cancellation_requested
                or cancelled,
                failure=str(error) if error is not None else None,
            )
            info = self._info
        self._finished(info.pid)
        self._completion.set_result(info)

    async def join(self) -> ProcessInfo:
        """Wait asynchronously, including from a different event loop."""
        return await asyncio.shield(asyncio.wrap_future(self._completion))
