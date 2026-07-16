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
from dataclasses import dataclass, field
from enum import Enum

from mirage.io.types import IOResult
from mirage.types import DEFAULT_SESSION_ID
from mirage.workspace.types import ExecutionNode


class JobStatus(str, Enum):
    RUNNING = "running"
    COMPLETED = "completed"
    KILLED = "killed"


@dataclass
class Job:
    id: int
    command: str
    task: asyncio.Task | None
    cwd: str
    status: JobStatus = JobStatus.RUNNING
    stdout: bytes = b""
    stderr: bytes = b""
    exit_code: int = 0
    execution_node: ExecutionNode | None = None
    io_result: IOResult | None = None
    created_at: float = field(default_factory=time.time)
    agent: str = "unknown"
    session_id: str = DEFAULT_SESSION_ID


class JobTable:

    def __init__(self) -> None:
        self._jobs: dict[int, Job] = {}
        self._next_id: int = 1

    def submit(
        self,
        command: str,
        task: asyncio.Task,
        cwd: str,
        agent: str = "unknown",
        session_id: str = DEFAULT_SESSION_ID,
    ) -> Job:
        job = Job(id=self._next_id,
                  command=command,
                  task=task,
                  cwd=cwd,
                  agent=agent,
                  session_id=session_id)
        self._jobs[job.id] = job
        self._next_id += 1
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
        but no one has called ``wait``, this updates the job's status,
        exit_code, and captured streams from the task result. Lets
        ``list_jobs`` / ``running_jobs`` / ``get`` report fresh state.
        Requires ``_run_bg`` to have already materialized stdout/stderr,
        so reading the result is purely synchronous.
        """
        if job.status != JobStatus.RUNNING:
            return
        assert job.task is not None
        if not job.task.done():
            return
        if job.task.cancelled():
            job.status = JobStatus.KILLED
            job.exit_code = 137
            job.stderr = b"Killed"
            return
        exc = job.task.exception()
        if exc is not None:
            job.status = JobStatus.COMPLETED
            job.exit_code = 1
            job.stderr = str(exc).encode()
            return
        stdout, io_result, exec_node = job.task.result()
        job.stdout = stdout if isinstance(stdout, bytes) else b""
        job.io_result = io_result
        job.execution_node = exec_node
        io_result.sync_exit_code()
        job.exit_code = io_result.exit_code
        if isinstance(io_result.stderr, bytes):
            job.stderr = io_result.stderr
        elif io_result.stderr is None:
            job.stderr = b""
        job.status = JobStatus.COMPLETED

    def kill(self, job_id: int) -> bool:
        job = self._jobs.get(job_id)
        if job is None:
            return False
        if job.task is not None:
            job.task.cancel()
        job.status = JobStatus.KILLED
        job.exit_code = 137
        job.stderr = b"Killed"
        return True

    async def wait(self, job_id: int) -> Job:
        job = self._jobs[job_id]
        if job.status != JobStatus.RUNNING:
            return job
        assert job.task is not None
        try:
            stdout, io_result, exec_node = await job.task
            job.stdout = stdout if isinstance(stdout, bytes) else b""
            job.io_result = io_result
            job.execution_node = exec_node
            io_result.sync_exit_code()
            job.exit_code = io_result.exit_code
            job.stderr = await io_result.materialize_stderr()
            job.status = JobStatus.COMPLETED
        except asyncio.CancelledError:
            job.status = JobStatus.KILLED
            job.exit_code = 137
            job.stderr = b"Killed"
        except Exception as exc:
            job.status = JobStatus.COMPLETED
            job.exit_code = 1
            job.stderr = str(exc).encode()
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
