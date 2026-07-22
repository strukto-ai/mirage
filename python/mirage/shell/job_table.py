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
from enum import Enum
from typing import Any

from mirage.io.types import IOResult
from mirage.shell.console import (KILLED_OUTCOME, Channel, JobConsole,
                                  exit_outcome)
from mirage.workspace.types import ExecutionNode

logger = logging.getLogger(__name__)

KILLED_EXIT_CODE = 137


class JobStatus(str, Enum):
    RUNNING = "running"
    COMPLETED = "completed"
    KILLED = "killed"


@dataclass
class Job:
    """One background command, and everything it has printed.

    Output lives in ``console`` rather than in byte fields, so a reader
    can watch a job while it runs instead of waiting for it to end.
    """

    id: int
    command: str
    task: asyncio.Task[Any] | None
    cwd: str
    status: JobStatus = JobStatus.RUNNING
    exit_code: int = 0
    console: JobConsole = field(default_factory=JobConsole)
    execution_node: ExecutionNode | None = None
    io_result: IOResult | None = None
    created_at: float = field(default_factory=time.time)
    agent: str = "unknown"
    session_id: str = ""


JobRunner = Callable[[Job], Coroutine[Any, Any, tuple[IOResult,
                                                      ExecutionNode]]]


def cancel_job(job: Job) -> None:
    """Ask a job to stop, from any thread, without waiting for it.

    Routed through the task's own loop because the caller is often
    somewhere else entirely: a sync teardown path, an agent adapter on a
    pool thread, a server request handler. Tolerates a loop that has
    already shut down, which is the normal case during interpreter exit.

    Args:
        job (Job): the job to cancel.
    """
    task = job.task
    if task is None:
        return
    try:
        task.get_loop().call_soon_threadsafe(task.cancel)
    except RuntimeError as exc:
        # The loop that was running this job is gone, so the job is too.
        logger.debug("job %d loop is gone: %s", job.id, exc)


async def _settle(run: JobRunner, job: Job) -> None:
    """Run a job to completion and record how it ended.

    Every write to a job's status, exit code, and console ending happens
    here, in the job's own task, so the table has exactly one writer and
    needs no locking. The runner only produces output.

    Status is set before the console is finished, so a reader released by
    the ending chunk always sees settled fields.

    Args:
        run (JobRunner): produces the job's output and its result.
        job (Job): the job being run.
    """
    try:
        io_result, exec_node = await run(job)
    except asyncio.CancelledError:
        job.status = JobStatus.KILLED
        job.exit_code = KILLED_EXIT_CODE
        # Awaiting while cancelled is safe only because the in-memory
        # console never suspends. A store that does needs shielding here.
        await job.console.emit(Channel.STDERR, b"Killed")
        await job.console.finish(KILLED_OUTCOME)
        raise
    except Exception as exc:
        # Recorded as the job's output and exit status rather than
        # re-raised: nobody awaits this task, so re-raising would only
        # strand the error in an unretrieved future.
        logger.debug("background job %d failed: %s", job.id, exc)
        job.status = JobStatus.COMPLETED
        job.exit_code = 1
        await job.console.emit(Channel.STDERR, str(exc).encode())
        await job.console.finish(exit_outcome(1))
        return
    job.io_result = io_result
    job.execution_node = exec_node
    io_result.sync_exit_code()
    job.exit_code = io_result.exit_code
    job.status = JobStatus.COMPLETED
    await job.console.finish(exit_outcome(job.exit_code))


class JobTable:

    def __init__(self) -> None:
        self._jobs: dict[int, Job] = {}
        self._next_id: int = 1

    def submit(
        self,
        command: str,
        run: JobRunner,
        cwd: str,
        agent: str = "unknown",
        session_id: str = "",
    ) -> Job:
        """Register a job and start it.

        The table creates the task itself so the runner is handed a job
        that already has a console. Building the task first would leave a
        window in which output could arrive with nowhere to go.

        Args:
            command (str): the command line being run.
            run (JobRunner): produces the job's output and its result.
            cwd (str): working directory the job was started from.
            agent (str): agent that started the job.
            session_id (str): session the job belongs to.
        """
        job = Job(id=self._next_id,
                  command=command,
                  task=None,
                  cwd=cwd,
                  agent=agent,
                  session_id=session_id)
        self._jobs[job.id] = job
        self._next_id += 1
        job.task = asyncio.create_task(_settle(run, job))
        return job

    def load(self, job: Job) -> None:
        """Insert a finished job restored from a snapshot.

        Args:
            job (Job): the restored job.
        """
        self._jobs[job.id] = job
        if job.id >= self._next_id:
            self._next_id = job.id + 1

    def get(self, job_id: int) -> Job | None:
        return self._jobs.get(job_id)

    def list_jobs(self) -> list[Job]:
        return list(self._jobs.values())

    def running_jobs(self) -> list[Job]:
        return [
            j for j in self._jobs.values() if j.status == JobStatus.RUNNING
        ]

    async def kill(self, job_id: int) -> bool:
        """Stop a job and wait for it to actually end.

        The cancel is routed through the task's own loop and the join
        happens on the console, never on the task, because a caller may
        be on a different thread and loop than the job (an agent adapter
        reaching in through the sync bridge, a server request handler).
        Awaiting a foreign task would raise; the console is loop-neutral.

        Args:
            job_id (int): the job to stop.
        """
        job = self._jobs.get(job_id)
        if job is None or job.status != JobStatus.RUNNING:
            return False
        if job.task is None:
            return False
        cancel_job(job)
        await job.console.wait_finished()
        return True

    async def kill_all(self) -> list[Job]:
        """Stop every running job, returning the ones that were running."""
        running = self.running_jobs()
        for job in running:
            await self.kill(job.id)
        return running

    async def wait(self, job_id: int) -> Job:
        """Block until a job ends, then return it.

        Args:
            job_id (int): the job to wait for.
        """
        job = self._jobs[job_id]
        if job.status != JobStatus.RUNNING:
            return job
        await job.console.wait_finished()
        return job

    async def wait_all(self) -> list[Job]:
        running = self.running_jobs()
        for job in running:
            await self.wait(job.id)
        return running

    def pop_completed(self) -> list[Job]:
        """Return completed/killed jobs and remove them from the table.

        A reader holding a job's console keeps reading it: the console
        outlives its table entry and dies with its last reader.
        """
        completed = [
            j for j in self._jobs.values() if j.status != JobStatus.RUNNING
        ]
        for j in completed:
            del self._jobs[j.id]
        return completed
