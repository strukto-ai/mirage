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

from dataclasses import dataclass

from mirage.agents.io_text import decode
from mirage.shell.job_table import Job, JobStatus
from mirage.workspace.workspace import Workspace


@dataclass(frozen=True, slots=True)
class BackgroundJob:
    """Status of one long-lived command.

    Args:
        shell_id (str): identifier used to read from or kill the job.
        command (str): the command line that was started.
        pid (int): the workspace's job number. Mirage runs background
            commands as tasks in-process, so there is no OS process id;
            this is the same number the ``jobs`` builtin reports.
        running (bool): whether the job is still executing.
        exit_code (int | None): exit status, or None while running.
    """

    shell_id: str
    command: str
    pid: int
    running: bool
    exit_code: int | None = None


@dataclass(frozen=True, slots=True)
class BackgroundChunk:
    """Output produced since the previous read of a job.

    Args:
        shell_id (str): the job this output came from.
        stdout (str): new stdout since the last read.
        stderr (str): new stderr since the last read.
        running (bool): whether the job is still executing.
        exit_code (int | None): exit status, or None while running.
    """

    shell_id: str
    stdout: str
    stderr: str
    running: bool
    exit_code: int | None = None


def _to_job(job: Job) -> BackgroundJob:
    running = job.status == JobStatus.RUNNING
    return BackgroundJob(
        shell_id=str(job.id),
        command=job.command,
        pid=job.id,
        running=running,
        exit_code=None if running else job.exit_code,
    )


class BackgroundJobs:
    """Incremental view over a workspace's background jobs.

    Wraps the job table that backs the shell's ``&`` operator and the
    ``jobs`` builtin, adding the per-reader cursor that agent harnesses
    expect: each :meth:`output` call returns only what is new since the
    previous one for that job.

    Output arrives in one piece when a job finishes rather than streaming
    while it runs, because the job table materializes a job's streams on
    completion. Reads before then are empty, not lost.
    """

    def __init__(self,
                 workspace: Workspace,
                 session_id: str | None = None) -> None:
        self._ws = workspace
        self._session_id = session_id
        self._drained: dict[str, tuple[int, int]] = {}

    def _job(self, shell_id: str) -> Job:
        try:
            job_id = int(shell_id)
        except ValueError:
            raise KeyError(shell_id) from None
        job = self._ws.job_table.get(job_id)
        if job is None:
            raise KeyError(shell_id)
        return job

    async def start(self, command: str) -> BackgroundJob:
        """Run a command detached and return its handle immediately.

        Args:
            command (str): the command line to run.
        """
        before = {job.id for job in self._ws.job_table.list_jobs()}
        await self._ws.execute(f"{command} &", session_id=self._session_id)
        started = [
            job for job in self._ws.job_table.list_jobs()
            if job.id not in before
        ]
        if not started:
            raise RuntimeError(f"background command did not start: {command}")
        return _to_job(max(started, key=lambda job: job.id))

    def output(self, shell_id: str) -> BackgroundChunk:
        """Drain the output a job has produced since the previous call.

        Args:
            shell_id (str): the job to read from.
        """
        job = self._job(shell_id)
        seen_out, seen_err = self._drained.get(shell_id, (0, 0))
        stdout = job.stdout[seen_out:]
        stderr = job.stderr[seen_err:]
        self._drained[shell_id] = (len(job.stdout), len(job.stderr))
        running = job.status == JobStatus.RUNNING
        return BackgroundChunk(
            shell_id=shell_id,
            stdout=decode(stdout),
            stderr=decode(stderr),
            running=running,
            exit_code=None if running else job.exit_code,
        )

    def info(self) -> list[BackgroundJob]:
        """Return the status of every tracked job."""
        return [_to_job(job) for job in self._ws.job_table.list_jobs()]

    def kill(self, shell_id: str) -> bool:
        """Stop a job, reporting whether it was still running.

        Args:
            shell_id (str): the job to stop.
        """
        try:
            job = self._job(shell_id)
        except KeyError:
            return False
        if job.status != JobStatus.RUNNING:
            return False
        return self._ws.job_table.kill(job.id)

    def kill_all(self) -> None:
        """Stop every running job and forget its read cursor."""
        for job in self._ws.job_table.running_jobs():
            self._ws.job_table.kill(job.id)
        self._drained.clear()
