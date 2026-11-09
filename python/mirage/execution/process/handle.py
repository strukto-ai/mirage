from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Coroutine, Sequence
from concurrent.futures import Future
from dataclasses import replace
from threading import RLock
from typing import Any, Protocol, TypeVar, cast

from mirage.concurrency.limiter import owned_task
from mirage.execution.process.types import (
    Process,
    ProcessRunner,
    ProcessState,
)
from mirage.execution.types import MachineId, MachinePid
from mirage.shell.constants import SIGTERM
from mirage.utils.clock import system_now

logger = logging.getLogger(__name__)

T = TypeVar("T")


class ExecutionBind(Protocol):
    """Run a process under the execution context its host provides."""

    async def __call__(
        self,
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
        record: Process,
        run: ProcessRunner,
        finished: Callable[[int], None],
        cancel_children: Callable[[int], None] = lambda signal: None,
        bind: ExecutionBind | None = None,
        ignores: frozenset[int] = frozenset(),
        now: Callable[[], float] = system_now,
    ) -> None:
        self._record = record
        self._now = now
        self.ignores = ignores
        self._run = run
        self._bind = bind
        self._lock = RLock()
        self._finished = finished
        self._cancel_children = cancel_children
        self._programs: dict[asyncio.Task[Any], int | None] = {}
        self._takes: dict[asyncio.Task[Any], frozenset[int] | None] = {}
        self._signal: int | None = None
        self._program_code: int | None = None
        self._program_signal: int | None = None
        self._completion: Future[Process] = Future()
        self.begun = False
        # Started for exactly one command, whose program, should it run
        # on a runtime of its own, runs as this process (``take``).
        self.one_command = False
        # What the program that takes it (``take``) ignores as well: a
        # job's INT and QUIT, never what only a shell ignores.
        self.program_ignores: frozenset[int] = frozenset()
        self._holds: dict[Callable[[bool], None], bool] = {}
        self._expired: int | None = None
        # The host stopped it (its table stopped, its session closed),
        # which ends whoever waits for it as well.
        self.revoked = False
        # Told the record each time it changes, as its table keeps it.
        self.noted: Callable[[Process], None] | None = None
        # It belongs to a background job, so nothing waits on it unless
        # something asks to.
        self.background = False
        # What a ``kill -STOP`` holds, its table's, by pid: each entry is
        # done at the ``kill -CONT``.
        self.pauses: dict[int, Future[None]] = {}
        # Done once ``$!`` can name it: its program's pid is known, its
        # pipeline's stages have started, or it has ended.
        self._placed: Future[None] = Future()
        # It runs a pipeline (``cmd | cmd &``), whose stages are the job.
        self.pipeline = False
        self.stages: tuple[ProcessHandle, ...] = ()

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
        return await self._bind(self._run, self)

    @property
    def record(self) -> Process:
        with self._lock:
            return self._record

    def _tell(self) -> None:
        """Tell whoever keeps the record that it changed."""
        if self.noted is not None:
            self.noted(self._record)

    @property
    def signal(self) -> int | None:
        """The signal the runner was stopped with, None while it runs."""
        with self._lock:
            return self._signal

    @property
    def ended_by(self) -> int | None:
        """The signal that ended the runner, None while it runs or once
        it exited on its own (a trap that handled the signal): the one
        it was stopped with, or the one that ended the native program
        its status is (``program_signaled``)."""
        if not self.task.done():
            return None
        if self.task.cancelled():
            return self.signal or 9
        with self._lock:
            ended = self._program_signal
            code = self._record.exit
        return ended if ended is not None and code == 128 + ended else None

    @property
    def interrupted(self) -> int | None:
        """The signal ``interrupt`` stops the program the runner runs
        right now with, None while none is stopping."""
        with self._lock:
            return next(
                (sent for sent in self._programs.values() if sent is not None),
                self._expired,
            )

    @property
    def program_code(self) -> int | None:
        """The status a program the runner started exited with on its
        own after the stop signal, None unless one did."""
        with self._lock:
            return self._program_code

    @property
    def ended_on(self) -> int | None:
        """The signal the native program the runner last started ended
        on (``program_signaled``), None once one exited on its own."""
        with self._lock:
            return self._program_signal

    def take(self, machine: MachineId | None, runtime: str) -> bool:
        """Take the runner as the program it was started for
        (``one_command``), which runs on ``machine`` with ``runtime``, as
        bash execs a stage's or a job's one program in place. Its record
        names both from then on, and it ignores only what the program
        does (``program_ignores``).

        Args:
            machine (MachineId | None): where the program runs; None for
                the workspace's own machine.
            runtime (str): what runs it.

        Returns:
            bool: whether the runner was the program's to take; False
            for one started for more than one command, or taken already.
        """
        with self._lock:
            if not self.one_command:
                return False
            self.one_command = False
            self.ignores = self.program_ignores
            self._record = replace(
                self._record,
                machine=machine or self._record.machine,
                runtime=runtime,
            )
            self._tell()
            return True

    def set_machine_pid(self, machine_pid: MachinePid) -> None:
        """Record the pid of the native program the runner is, on its
        machine, which a workspace that outlives this one stops it by.

        Args:
            machine_pid (MachinePid): the program's pid and start, and
                when it exited, once it did.
        """
        with self._lock:
            self._record = replace(self._record, machine_pid=machine_pid)
            self._tell()
            if not self._placed.done():
                self._placed.set_result(None)

    def set_stages(self, stages: Sequence[ProcessHandle]) -> None:
        """Note the stages of the pipeline this job runs, which ``$!``
        and ``jobs -l`` name.

        Args:
            stages (Sequence[ProcessHandle]): the stages, in order.
        """
        with self._lock:
            self.stages = tuple(stages)
            pids = tuple(stage.record.pid for stage in stages)
            self._record = replace(self._record, stages=pids)
            if not self._placed.done():
                self._placed.set_result(None)

    def show_state(self, state: str | None) -> None:
        """Note what a scan found the program doing, or that a ``kill``
        paused it, which is ``ps``'s to show and no store's to keep.

        Args:
            state (str | None): its state letter; None for none known.
        """
        with self._lock:
            self._record = replace(self._record, shown_state=state)

    @property
    def paused(self) -> bool:
        """Whether a ``kill -STOP`` holds this process or one above it."""
        return self._held_by() is not None

    def _held_by(self) -> Future[None] | None:
        if not self.pauses:
            return None
        record = self._record
        return next(
            (
                self.pauses[pid]
                for pid in (record.pid, *record.ancestors)
                if pid in self.pauses
            ),
            None,
        )

    def on_hold(self, hold: Callable[[bool], None]) -> Callable[[], None]:
        """Tell a program that goes on between the calls it makes to
        Mirage, and has a way of its own to stop, when a ``kill -STOP``
        holds this process. One already held is told at once.

        Args:
            hold (Callable[[bool], None]): told True as the process is
                held and False as it goes on.

        Returns:
            Callable[[], None]: what forgets ``hold``, letting a program
            still held go.
        """
        with self._lock:
            self._holds[hold] = False

        def forget() -> None:
            with self._lock:
                told = self._holds.pop(hold, False)
            if told:
                hold(False)

        self.tell_held()
        return forget

    def tell_held(self) -> None:
        """Tell each program waiting to hear (``on_hold``) whether this
        process is held now."""
        held = self.paused
        with self._lock:
            changed = [h for h, told in self._holds.items() if told != held]
            self._holds.update(dict.fromkeys(changed, held))
        for hold in changed:
            hold(held)

    def expire(self) -> None:
        """Note that a deadline (``@line``) is past: what the runner runs
        takes TERM as a ``kill`` would have it send, with a program's grace
        to finish (``interrupted``), and a ``kill -STOP`` no longer holds
        it. The runner's own status stays the deadline's.
        """
        self._expired = SIGTERM
        held = self.pauses.pop(self.record.pid, None)
        if held is not None:
            held.set_result(None)
        self.tell_held()

    async def resumed(self) -> None:
        """Wait out a ``kill -STOP`` of this process or one above it."""
        while (held := self._held_by()) is not None:
            await asyncio.shield(asyncio.wrap_future(held))

    async def placed(self, seconds: float) -> None:
        """Wait until ``$!`` can name the program this runs: its pid on
        its machine is known or it has ended, for at most ``seconds``.

        Args:
            seconds (float): how long to wait.
        """
        await asyncio.wait(
            {asyncio.wrap_future(self._placed)}, timeout=seconds
        )

    def program_exited(self, code: int) -> None:
        """Record that a program the runner started handled the stop
        signal and exited: a job that is that one program reports its
        status, as bash reports a child that handled the signal.

        Args:
            code (int): the program's exit status.
        """
        with self._lock:
            self._program_code = code

    def program_signaled(self, signal: int | None) -> None:
        """Record that a native program the runner started ended on a
        signal, which names the runner's end when its status is that
        program's (``true | python3 -c 'os.kill(os.getpid(), 9)'``).
        Every statement the runner starts clears it, so only the last
        one's end counts.

        Args:
            signal (int | None): the signal that ended the program; None
                as a statement starts.
        """
        with self._lock:
            self._program_signal = signal

    async def program(
        self,
        run: Callable[[], Coroutine[Any, Any, T]],
        takes: frozenset[int] | None = None,
    ) -> tuple[T, None] | tuple[None, int]:
        """Run one program of the runner's shell where ``interrupt``
        reaches it, as bash's background job runs each program as a
        child that takes the INT the job itself ignores.

        Args:
            run (Callable[[], Coroutine[Any, Any, T]]): the program, to
                its end.
            takes (frozenset[int] | None): the signals that stop it,
                every one when None.

        Returns:
            tuple[T, None] | tuple[None, int]: what it returned, or the
            signal ``interrupt`` stopped it with.
        """
        # Eager, so the program begins where the statement stands, before
        # what the shell runs next (a job's redirect lands first).
        task: asyncio.Task[T] = asyncio.Task(
            run(), loop=asyncio.get_running_loop(), eager_start=True
        )
        with self._lock:
            self._programs[task] = None
            self._takes[task] = takes
        try:
            return await task, None
        except asyncio.CancelledError:
            current = asyncio.current_task()
            signal = self._programs.get(task)
            if signal is None or (
                current is not None and current.cancelling()
            ):
                raise
            return None, signal
        finally:
            with self._lock:
                self._programs.pop(task, None)
                self._takes.pop(task, None)

    def interrupt(self, signal: int) -> None:
        """Deliver a signal the runner's shell ignores, as bash's
        background job ignores INT: the program it runs right now
        (``program``) gets it, and the shell goes on.

        Args:
            signal (int): the signal.
        """
        with self._lock:
            running = [
                task
                for task, sent in self._programs.items()
                if sent is None
                and (
                    (takes := self._takes.get(task)) is None or signal in takes
                )
            ]
            for task in running:
                self._programs[task] = signal
        for task in running:
            task.get_loop().call_soon_threadsafe(task.cancel)

    def terminate(self, signal: int = 9, children: bool = True) -> bool:
        """Request cancellation without waiting for the runner to exit.

        A runner that already exited has nothing to cancel, but what it
        started may still run (``sh -c 'sleep 100 &'``), so its children
        are stopped all the same. A KILL while the runner still stops
        under another signal cuts the grace that signal gave its program
        short, as a second ``kill -KILL`` does. A signal the runner
        ignores (``ignores``) does nothing.

        Args:
            signal (int): what the stop stands for, KILL (9) unless a
                ``kill`` named another.
            children (bool): stop what the runner started too; False
                leaves its jobs running, for a signal they ignore.
        """
        if signal in self.ignores:
            return False
        with self._lock:
            exited = self._record.state == ProcessState.EXITED
            stopped = self._record.state == ProcessState.RUNNING
            escalated = (
                not exited
                and not stopped
                and signal == 9
                and self._signal != 9
            )
            if stopped:
                self._signal = signal
                self.task.get_loop().call_soon_threadsafe(self.task.cancel)
                self._record = replace(
                    self._record, state=ProcessState.STOPPING
                )
                self._tell()
            elif escalated:
                self._signal = signal
        if children and (stopped or exited or escalated):
            self._cancel_children(signal)
        return stopped or escalated

    def _settle(self, task: asyncio.Task[int]) -> None:
        cancelled = task.cancelled()
        error = None if cancelled else task.exception()
        if error is not None:
            logger.debug("process %d failed: %s", self._record.pid, error)
        with self._lock:
            # Read with the exit published, so a KILL another thread sends
            # meanwhile is either refused or the status it reports.
            if cancelled:
                code = 128 + (self._signal or 9)
                signal: int | None = self._signal or 9
            else:
                code = 1 if error is not None else task.result()
                stop, ended = self._signal, self._program_signal
                if stop is not None and code == 128 + stop:
                    signal = stop
                elif ended is not None and code == 128 + ended:
                    signal = ended
                else:
                    signal = None
            self._record = replace(
                self._record,
                state=ProcessState.EXITED,
                ended_at=self._now(),
                exit=code,
                signal=signal,
                error=str(error) if error is not None else None,
            )
            self._tell()
            record = self._record
            if not self._placed.done():
                self._placed.set_result(None)
        self._finished(record.pid)
        self._completion.set_result(record)

    async def join(self) -> Process:
        """Wait asynchronously, including from a different event loop."""
        return await asyncio.shield(asyncio.wrap_future(self._completion))

    async def reap(self) -> int:
        """Wait for the runner from the shell that forked it, as wait(2)
        does: its exit status, 128 plus the signal that stopped it. A
        stop of the waiting shell itself stops the runner with it, and a
        runner the host stopped (``revoked``) ends the wait cancelled.

        Returns:
            int: the status.
        """
        try:
            return await self.task
        except asyncio.CancelledError:
            current = asyncio.current_task()
            if self.revoked or (current is not None and current.cancelling()):
                raise
            return 128 + (self.signal or 9)
