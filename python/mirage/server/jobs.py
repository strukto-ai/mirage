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
import concurrent.futures
import functools
import logging
import secrets
import time
from enum import Enum
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)


class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    CANCELED = "canceled"


def new_job_id() -> str:
    """Mint a fresh job id of the form ``job_<16 hex chars>``."""
    return f"job_{secrets.token_hex(8)}"


class JobEntry:
    """One in-flight or completed daemon-level execute job."""

    def __init__(self, job_id: str, workspace_id: str, command: str) -> None:
        self.id = job_id
        self.workspace_id = workspace_id
        self.command = command
        self.status: JobStatus = JobStatus.PENDING
        self.result: Any = None
        self.error: str | None = None
        self.submitted_at: float = time.time()
        self.started_at: float | None = None
        self.finished_at: float | None = None
        self._future: concurrent.futures.Future[Any] | None = None
        self._done_event: asyncio.Event = asyncio.Event()


class JobTable:
    """Daemon-wide table of execute jobs.

    Tracks both sync and background jobs so the CLI can query
    progress, wait, and cancel uniformly. Sync calls register the job
    in pending/running and complete it before returning.
    """

    def __init__(self) -> None:
        self._jobs: dict[str, JobEntry] = {}

    def __contains__(self, job_id: str) -> bool:
        return job_id in self._jobs

    def get(self, job_id: str) -> JobEntry:
        if job_id not in self._jobs:
            raise KeyError(job_id)
        return self._jobs[job_id]

    def list(self, workspace_id: str | None = None) -> list[JobEntry]:
        if workspace_id is None:
            return list(self._jobs.values())
        return [
            j for j in self._jobs.values() if j.workspace_id == workspace_id
        ]

    def submit(self, workspace_id: str, command: str,
               schedule: Callable[[Awaitable[Any]],
                                  concurrent.futures.Future[Any]],
               coro_factory: Callable[[], Awaitable[Any]]) -> JobEntry:
        """Register a job and start running it on the workspace loop.

        Args:
            workspace_id (str): workspace this job belongs to.
            command (str): user-visible command string for display.
            schedule (Callable): function that takes a coroutine and
                returns a ``concurrent.futures.Future`` representing
                its execution on the workspace loop. Typically
                ``functools.partial(asyncio.run_coroutine_threadsafe,
                loop=runner.loop)`` -- but the runner's
                ``call``-equivalent is fine too.
            coro_factory (Callable): zero-arg callable that builds the
                coroutine to schedule. Called once.

        Returns:
            JobEntry: the registered entry. Inspect ``entry._future``
                to await or cancel.
        """
        job_id = new_job_id()
        entry = JobEntry(job_id, workspace_id, command)
        self._jobs[job_id] = entry
        coro = coro_factory()
        fut = schedule(coro)
        entry._future = fut
        entry.status = JobStatus.RUNNING
        entry.started_at = time.time()
        loop = asyncio.get_running_loop()
        callback = functools.partial(self._dispatch_done, entry, loop)
        fut.add_done_callback(callback)
        return entry

    def _dispatch_done(self, entry: JobEntry, loop: asyncio.AbstractEventLoop,
                       fut: concurrent.futures.Future[Any]) -> None:
        loop.call_soon_threadsafe(self._on_done, entry, fut)

    def _on_done(self, entry: JobEntry,
                 fut: concurrent.futures.Future[Any]) -> None:
        entry.finished_at = time.time()
        if fut.cancelled():
            entry.status = JobStatus.CANCELED
        else:
            exc = fut.exception()
            if exc is not None:
                entry.status = JobStatus.FAILED
                entry.error = f"{type(exc).__name__}: {exc}"
            else:
                entry.status = JobStatus.DONE
                entry.result = fut.result()
        entry._done_event.set()

    async def wait(self,
                   job_id: str,
                   timeout: float | None = None) -> JobEntry:
        entry = self.get(job_id)
        if entry.status in (JobStatus.DONE, JobStatus.FAILED,
                            JobStatus.CANCELED):
            return entry
        try:
            await asyncio.wait_for(entry._done_event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            return entry
        return entry

    def cancel(self, job_id: str) -> bool:
        entry = self.get(job_id)
        if entry.status in (JobStatus.DONE, JobStatus.FAILED,
                            JobStatus.CANCELED):
            return False
        if entry._future is None:
            return False
        return entry._future.cancel()
