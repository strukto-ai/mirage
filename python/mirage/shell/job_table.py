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
import time
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from mirage.io.types import IOResult
from mirage.workspace.types import ExecutionNode


class JobStatus(str, Enum):
    RUNNING = "running"
    COMPLETED = "completed"
    KILLED = "killed"


@dataclass
class Job:
    """One background command and the output it has produced so far.

    ``stdout`` and ``stderr`` grow while the job runs: the runner appends
    to them as chunks arrive, so a reader can watch a long job instead of
    waiting for it to finish.
    """

    id: int
    command: str
    task: asyncio.Task[Any] | None
    cwd: str
    status: JobStatus = JobStatus.RUNNING
    stdout: bytes = b""
    stderr: bytes = b""
    exit_code: int = 0
    execution_node: ExecutionNode | None = None
    io_result: IOResult | None = None
    created_at: float = field(default_factory=time.time)
    agent: str = "unknown"
    session_id: str = ""


JobRunner = Callable[[Job], Coroutine[Any, Any, tuple[IOResult,
                                                      ExecutionNode]]]


def _note_killed(job: Job) -> None:
    """Record that a job was killed, keeping what it already printed.

    Args:
        job (Job): the job being stopped.
    """
    if job.stderr and not job.stderr.endswith(b"\n"):
        job.stderr += b"\n"
    job.stderr += b"Killed"


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

        The table creates the task itself so the runner is handed the job
        it writes into. Building the task first would leave a window in
        which output could arrive with nowhere to go.

        Args:
            command (str): the command line being run.
            run (JobRunner): coroutine factory taking the job to fill.
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
        job.task = asyncio.create_task(run(job))
        return job

    def get(self, job_id: int) -> Job | None:
        job = self._jobs.get(job_id)
        if job is not None:
            self._refresh(job)
        return job

    def list_jobs(self) -> list[Job]:
        jobs = list(self._jobs.values())
        for j in jobs:
            self._refresh(j)
        return jobs

    def running_jobs(self) -> list[Job]:
        for j in self._jobs.values():
            self._refresh(j)
        return [
            j for j in self._jobs.values() if j.status == JobStatus.RUNNING
        ]

    def _refresh(self, job: Job) -> None:
        """Sync status from the underlying asyncio task without awaiting.

        When the bg task has finished (normally, raised, or was cancelled)
        but no one has called ``wait``, this settles the job's status and
        exit_code. Lets ``list_jobs`` / ``running_jobs`` / ``get`` report
        fresh state. Output is not read from the task result: the runner
        has been appending it to the job all along.
        """
        if job.status != JobStatus.RUNNING:
            return
        assert job.task is not None
        if not job.task.done():
            return
        if job.task.cancelled():
            job.status = JobStatus.KILLED
            job.exit_code = 137
            _note_killed(job)
            return
        exc = job.task.exception()
        if exc is not None:
            job.status = JobStatus.COMPLETED
            job.exit_code = 1
            job.stderr += str(exc).encode()
            return
        io_result, exec_node = job.task.result()
        job.io_result = io_result
        job.execution_node = exec_node
        io_result.sync_exit_code()
        job.exit_code = io_result.exit_code
        job.status = JobStatus.COMPLETED

    def kill(self, job_id: int) -> bool:
        job = self._jobs.get(job_id)
        if job is None:
            return False
        if job.task is not None:
            job.task.cancel()
        if job.status != JobStatus.KILLED:
            _note_killed(job)
        job.status = JobStatus.KILLED
        job.exit_code = 137
        return True

    async def wait(self, job_id: int) -> Job:
        job = self._jobs[job_id]
        if job.status != JobStatus.RUNNING:
            return job
        assert job.task is not None
        try:
            io_result, exec_node = await job.task
            job.io_result = io_result
            job.execution_node = exec_node
            io_result.sync_exit_code()
            job.exit_code = io_result.exit_code
            job.status = JobStatus.COMPLETED
        except asyncio.CancelledError:
            job.status = JobStatus.KILLED
            job.exit_code = 137
            _note_killed(job)
        except Exception as exc:
            job.status = JobStatus.COMPLETED
            job.exit_code = 1
            job.stderr += str(exc).encode()
        return job

    async def wait_all(self) -> list[Job]:
        running = self.running_jobs()
        for job in running:
            await self.wait(job.id)
        return running

    def pop_completed(self) -> list[Job]:
        """Return completed/killed jobs and remove them from the table."""
        completed = [
            j for j in self._jobs.values() if j.status != JobStatus.RUNNING
        ]
        for j in completed:
            del self._jobs[j.id]
        return completed
