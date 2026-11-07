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
import time
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from typing import Any

from mirage.execution.job.constants import (
    KILLED_EXIT_CODE,
    WATCH_RETRY_SECONDS,
)
from mirage.execution.job.types import Job, JobState
from mirage.execution.process.handle import ProcessHandle
from mirage.execution.types import JobId, LineId
from mirage.io.types import IOResult
from mirage.shell.bytes import encode_text
from mirage.shell.console import (
    KILLED_OUTCOME,
    Channel,
    JobConsole,
    exit_outcome,
    killed_outcome,
)
from mirage.workspace.types import ExecutionNode

logger = logging.getLogger(__name__)


def _ending(outcome: str) -> tuple[int, int | None]:
    """The status and signal a console's ending records.

    Args:
        outcome (str): the ending's text, ``exit:<code>`` or
            ``killed:<code>:<signal>``.
    """
    form, _, rest = outcome.partition(":")
    if form != KILLED_OUTCOME:
        return int(rest), None
    code, _, signal = rest.partition(":")
    return int(code), int(signal)


async def mark_killed(
    console: JobConsole, exit_code: int, signal: int
) -> None:
    """Write the kill marker and the ending chunk.

    Args:
        console (JobConsole): the killed job's console.
        exit_code (int): the status the job answers.
        signal (int): the signal it was stopped with.
    """
    await console.emit(Channel.STDERR, b"Killed")
    await console.finish(killed_outcome(exit_code, signal))


@dataclass
class JobHandle:
    """One background command as the daemon running or listing it holds
    it: its runner, its console, and how it ended. ``record`` is the
    ``Job`` every daemon on the store reads.

    Output lives in ``console`` rather than in byte fields, so a reader
    can watch a job while it runs instead of waiting for it to end. A
    ``simple`` job is one simple command, which the job is, so a program
    it ran that handled a ``kill`` leaves the job its own status. Its
    ``owner`` is the daemon that runs it; a job another daemon runs has
    no ``process`` here. Its ``console_name`` is the name its store keeps
    the console under, which tells apart two jobs a reused number gave
    the same id. A ``reported`` job's shell printed the report of the
    signal that ended it, so ``jobs`` and a ``%N`` no longer name it,
    and its pid still answers ``wait``.

    A job a ``kill`` reached is ``stopping`` until its console ends, the
    one record of how it ended, which every daemon reads: the first
    ending written stands, and the handle takes it (``take``).
    """

    id: int
    command: str
    cwd: str
    created_at: float
    state: JobState = JobState.RUNNING
    exit_code: int = 0
    signal: int | None = None
    ended_at: float | None = None
    console: JobConsole = field(default_factory=JobConsole)
    session_id: str = ""
    process: ProcessHandle | None = None
    simple: bool = False
    owner: str = ""
    console_name: str = ""
    reported: bool = False
    workspace_id: str = ""
    line: LineId | None = None
    group: int | None = None
    now: Callable[[], float] = field(default=time.time, repr=False)

    @property
    def record(self) -> Job:
        """The job as its record reads."""
        ended = self.state == JobState.EXITED
        return Job(
            id=JobId(self.workspace_id, self.console_name),
            number=self.id,
            session_id=self.session_id,
            command=self.command,
            cwd=self.cwd,
            started_at=self.created_at,
            line=self.line,
            group=self.group,
            state=self.state,
            ended_at=self.ended_at,
            exit=self.exit_code if ended else None,
            signal=self.signal,
        )

    @property
    def process_id(self) -> str | None:
        """The id of the process the job runs as, as text: its runner's
        here, its console's for a job restored or run elsewhere."""
        return (
            str(self.process.record.id)
            if self.process is not None
            else self.console.process
        )

    @property
    def pid(self) -> int:
        """The managed PID `$!`, `jobs -p` and `wait -p` report.

        A job restored from a snapshot or run by another workspace has
        no runner here, so its job number stands in.
        """
        return self.process.record.pid if self.process is not None else self.id

    def take(self, outcome: str) -> None:
        """Take how the job ended from its console's ending.

        Args:
            outcome (str): the ending's text.
        """
        self.exit_code, self.signal = _ending(outcome)
        self._mark_ended()

    def _mark_ended(self) -> None:
        """Mark the job ended, now, unless it already was."""
        if self.state != JobState.EXITED:
            self.state, self.ended_at = JobState.EXITED, self.now()

    def cancel(self, signal: int = 9) -> None:
        """Ask the job's runner to stop, from any thread, without
        waiting for it.

        Routed through the task's own loop because the caller is often
        somewhere else entirely: a sync teardown path, an agent adapter
        on a pool thread, a server request handler. Tolerates a loop that
        has already shut down, which is the normal case during
        interpreter exit.

        Args:
            signal (int): what the stop stands for, KILL (9) unless a
                ``kill`` named another.
        """
        try:
            if self.process is not None:
                self.process.terminate(signal)
        except RuntimeError as exc:
            # The loop that was running this job is gone, so the job is too.
            logger.debug("job %d loop is gone: %s", self.id, exc)

    def kill(self, signal: int) -> None:
        """Stop the job's runner, the job answering as killed by
        ``signal`` while it stops.

        Args:
            signal (int): the signal it is stopped with; its status is
                128 plus it.
        """
        self.cancel(signal)
        self.state = JobState.STOPPING
        self.signal, self.exit_code = signal, 128 + signal

    async def stop(self, signal: int = 9) -> None:
        """Stop the job and end it as killed by ``signal`` at once.

        Args:
            signal (int): the signal it is stopped with; its status is
                128 plus it.
        """
        self.cancel(signal)
        await self.end(128 + signal, signal)

    async def end(self, exit_code: int, signal: int | None = None) -> None:
        """End the job's console with how it ended, then take the ending
        the console holds.

        Another workspace's ``kill``, or the bound on a killed job's
        stop, may have ended the console first; the store keeps the first
        ending, and every workspace answers that one. The job's fields
        are set before the console is finished, so a reader released by
        the ending chunk always sees them settled.

        Args:
            exit_code (int): the status it answers.
            signal (int | None): the signal it was stopped with, None
                for a job that ran to completion.
        """
        self.exit_code, self.signal = exit_code, signal
        self._mark_ended()
        if signal is not None:
            await mark_killed(self.console, exit_code, signal)
        else:
            await self.console.finish(exit_outcome(exit_code))
        if self.console.store.closed:
            return
        outcome = await self.console.outcome()
        if outcome is not None:
            self.take(outcome)

    def _stopped(self) -> tuple[int, int]:
        """The status and signal a stopped job answers: the status its
        program exited with after handling the signal, when the job is
        that one program, else 128 plus the signal, KILL's 137 without
        one."""
        signal = self.process.signal if self.process is not None else None
        if signal is None:
            signal = KILLED_EXIT_CODE - 128
        if self.process is not None and self.simple:
            code = self.process.program_code
            if code is not None:
                return code, signal
        return 128 + signal, signal

    async def settle(self, run: "JobRunner") -> int:
        """Run the job to completion and record how it ended.

        A job's console ends here, in the job's own task, once its
        runner has: ``kill`` only stops the runner, so a program that
        handled the signal leaves its own status (``_stopped``) in
        the ending every workspace reads. A job something stopped ends as
        killed however its runner finished.

        Args:
            run (JobRunner): produces the job's output and its result.
        """
        try:
            io_result, _ = await run(self)
        except asyncio.CancelledError:
            # This task is already unwinding from a cancel, and a store
            # that suspends (Redis) would take a second cancellation
            # mid-write and lose the ending readers are parked on. The
            # shielded task keeps running to completion even if this one
            # is cancelled again; RAM completes without ever suspending
            # either way.
            ending = asyncio.ensure_future(self.end(*self._stopped()))
            while not ending.done():
                try:
                    await asyncio.shield(ending)
                except asyncio.CancelledError:
                    logger.debug(
                        "job %d cancelled again while ending", self.id
                    )
            ending.result()
            raise
        except Exception as exc:
            # Recorded as the job's output and exit status rather than
            # re-raised: nobody awaits this task, so re-raising would only
            # strand the error in an unretrieved future.
            logger.debug("background job %d failed: %s", self.id, exc)
            if self.state != JobState.RUNNING:
                await self.end(*self._stopped())
                return 1
            await self.console.emit(Channel.STDERR, encode_text(str(exc)))
            await self.end(1)
            return 1
        if self.state != JobState.RUNNING:
            await self.end(*self._stopped())
        else:
            await self.end(io_result.exit_code)
        return io_result.exit_code

    async def adopt_ending(self) -> None:
        """Stop the job's runner if another workspace ended its console.

        A ``kill`` elsewhere ends the job's console, the one record of
        how the job ended, and this cancels the runner the way a local
        kill does, with the signal the ending records.
        """
        if self.state != JobState.RUNNING:
            return
        outcome = await self.console.outcome()
        if outcome is None or self.state != JobState.RUNNING:
            return
        self.take(outcome)
        self.cancel(self.signal if self.signal is not None else 9)

    async def watch(self) -> None:
        """Stop the job's runner once another workspace ends it.

        A failed read is retried until the runner settles, which cancels
        the watch: one that gave up would leave a kill from elsewhere
        unheeded while the job ran on.
        """
        store = self.console.store
        while not store.closed:
            try:
                await store.wait_ended()
                await self.adopt_ending()
                return
            except Exception as exc:
                logger.debug("job %d watch failed: %s", self.id, exc)
            await asyncio.sleep(WATCH_RETRY_SECONDS)


JobRunner = Callable[
    [JobHandle], Coroutine[Any, Any, tuple[IOResult, ExecutionNode]]
]
