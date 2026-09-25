import asyncio
import logging
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import replace
from threading import RLock

from mirage.process.cleanup import with_process_cleanup
from mirage.process.types import ProcessInfo, ProcessRunner, ProcessState

logger = logging.getLogger(__name__)


class ProcessHandle:
    """Host-side lifecycle of one asynchronous runner.

    Termination requests cancellation once. Joining waits for the runner,
    including its finally blocks; it does not assert that a provider has
    stopped native descendants. A cancelled waiter never cancels the runner.
    """

    def __init__(self,
                 info: ProcessInfo,
                 run: ProcessRunner,
                 finished: Callable[[int], None],
                 cancel_children: Callable[[], None] = lambda: None) -> None:
        self._info = info
        self._lock = RLock()
        self._finished = finished
        self._cancel_children = cancel_children
        self._completion: Future[ProcessInfo] = Future()
        self.task = asyncio.create_task(with_process_cleanup(run))
        self.task.add_done_callback(self._settle)

    @property
    def info(self) -> ProcessInfo:
        with self._lock:
            return self._info

    def terminate(self) -> bool:
        """Request cancellation without waiting for the runner to exit."""
        with self._lock:
            if (self._info.state == ProcessState.EXITED
                    or self._info.cancellation_requested):
                return False
            self.task.get_loop().call_soon_threadsafe(self.task.cancel)
            self._info = replace(self._info,
                                 state=ProcessState.STOPPING,
                                 cancellation_requested=True)
        self._cancel_children()
        return True

    def _settle(self, task: asyncio.Task[int]) -> None:
        cancelled = task.cancelled()
        error = None if cancelled else task.exception()
        if error is not None:
            logger.debug("process %d failed: %s", self._info.pid, error)
        code = 137 if cancelled else 1 if error is not None else task.result()
        with self._lock:
            self._info = replace(
                self._info,
                state=ProcessState.EXITED,
                exit_code=code,
                cancellation_requested=self._info.cancellation_requested
                or cancelled,
                failure=str(error) if error is not None else None)
            info = self._info
        self._finished(info.pid)
        self._completion.set_result(info)

    async def join(self) -> ProcessInfo:
        """Wait asynchronously, including from a different event loop."""
        return await asyncio.shield(asyncio.wrap_future(self._completion))
