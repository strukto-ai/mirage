from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import replace
from threading import RLock
from typing import Protocol, cast

from mirage.concurrency.limiter import owned_task
from mirage.process.types import ProcessInfo, ProcessRunner, ProcessState

logger = logging.getLogger(__name__)


class ExecutionBind(Protocol):
    """Run a process under the execution context its host provides."""

    async def __call__(
        self,
        execution_id: str,
        run: ProcessRunner,
        process: ProcessHandle,
    ) -> int: ...


class ProcessHandle:
    """Host-side lifecycle of one asynchronous runner.

    Termination requests cancellation once, standing for a signal: a
    native program the runner started receives it, and a cancelled
    runner's status is 128 plus it, as a shell reports a child the
    signal ended. Joining waits for the runner, including its finally
    blocks; it does not assert that a provider has stopped native
    descendants. A cancelled waiter never cancels the runner.

    The runner starts once ``start`` is called, so whoever tracks the
    handle registers it before even a synchronous prelude of the runner
    runs.
    """

    task: asyncio.Task[int]

    def __init__(
        self,
        info: ProcessInfo,
        run: ProcessRunner,
        finished: Callable[[int], None],
        cancel_children: Callable[[int], None] = lambda signal: None,
        bind: ExecutionBind | None = None,
    ) -> None:
        self._info = info
        self._run = run
        self._bind = bind
        self._lock = RLock()
        self._finished = finished
        self._cancel_children = cancel_children
        self._signal: int | None = None
        self._program_code: int | None = None
        self._completion: Future[ProcessInfo] = Future()
        self.begun = False

    def start(self, eager: bool = False) -> None:
        """Start the runner.

        Args:
            eager (bool): run it at once, up to its first wait, so a
                runner that never waits is done, and settled, before
                this returns and costs the loop no turn; otherwise it
                starts on the loop's next turn.
        """
        work = self._work()
        self.task = owned_task(work) if eager else asyncio.create_task(work)
        if self.task.done():
            self._settle(self.task)
        else:
            self.task.add_done_callback(self._settle)

    async def _work(self) -> int:
        self.task = cast("asyncio.Task[int]", asyncio.current_task())
        self.begun = True
        if self._bind is None:
            return await self._run()
        return await self._bind(self._info.execution_id, self._run, self)

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

        A runner that already exited has nothing to cancel, but what it
        started may still run (``sh -c 'sleep 100 &'``), so its children
        are stopped all the same.

        Args:
            signal (int): what the stop stands for, KILL (9) unless a
                ``kill`` named another.
        """
        with self._lock:
            exited = self._info.state == ProcessState.EXITED
            stopped = not exited and not self._info.cancellation_requested
            if stopped:
                self._signal = signal
                self.task.get_loop().call_soon_threadsafe(self.task.cancel)
                self._info = replace(
                    self._info,
                    state=ProcessState.STOPPING,
                    cancellation_requested=True,
                )
        if stopped or exited:
            self._cancel_children(signal)
        return stopped

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
