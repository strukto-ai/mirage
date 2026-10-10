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
from collections.abc import Awaitable, Callable
from dataclasses import replace

import anyio

from mirage.concurrency.limiter import settle
from mirage.execution.context import new_execution_id
from mirage.execution.types import ExecutionRecord as JobEntry
from mirage.execution.types import ExecutionStatus as JobStatus
from mirage.server.constants import (
    FINISHED_JOB_RETENTION_SECONDS,
    MAX_FINISHED_JOBS,
)
from mirage.types import JsonValue
from mirage.utils.abort import MirageAbortError
from mirage.workspace.execution import ExecutionScope

logger = logging.getLogger(__name__)


class _Run:
    def __init__(self, record: JobEntry) -> None:
        self.record = record
        self.work: asyncio.Task[JsonValue] | None = None
        self.completion: asyncio.Task[None] | None = None
        self.settled = asyncio.Event()


class JobTable:
    """The server's executions: each one's record and the work running it.

    A shell marks running only after acquiring its session. Cancel stops
    the work at once; the record finishes after the work and its cleanup
    settle. Finished records are kept for an hour, the newest 1024 of them.
    """

    def __init__(self) -> None:
        self._runs: dict[str, _Run] = {}
        self._closed = False
        self._closing: asyncio.Task[None] | None = None

    def get(self, job_id: str) -> JobEntry:
        self._prune()
        return self._runs[job_id].record

    def list(self, workspace_id: str | None = None) -> list[JobEntry]:
        self._prune()
        return [
            run.record
            for run in self._runs.values()
            if workspace_id is None or run.record.workspace_id == workspace_id
        ]

    def _prune(self) -> None:
        finished = sorted(
            (
                r
                for r in self._runs.values()
                if r.record.finished_at is not None
            ),
            key=lambda r: r.record.finished_at or 0,
        )
        cutoff = time.time() - FINISHED_JOB_RETENTION_SECONDS
        excess = len(finished) - MAX_FINISHED_JOBS
        for index, run in enumerate(finished):
            if index >= excess and (run.record.finished_at or 0) > cutoff:
                break
            del self._runs[run.record.id]

    async def _started(self, job_id: str) -> None:
        run = self._runs[job_id]
        if run.record.cancel_requested:
            raise asyncio.CancelledError()
        run.record = replace(
            run.record, status=JobStatus.RUNNING, started_at=time.time()
        )

    def submit(
        self,
        workspace_id: str,
        command: str,
        factory: Callable[[ExecutionScope], Awaitable[JsonValue]],
        *,
        session_id: str,
    ) -> JobEntry:
        if self._closed:
            raise RuntimeError("job table is closed")
        self._prune()
        run = _Run(
            JobEntry(
                new_execution_id(),
                workspace_id,
                session_id,
                command,
                time.time(),
            )
        )
        self._runs[run.record.id] = run
        run.completion = asyncio.create_task(self._run(run, factory))
        return run.record

    async def _run(
        self,
        run: _Run,
        factory: Callable[[ExecutionScope], Awaitable[JsonValue]],
    ) -> None:
        owner = asyncio.get_running_loop()
        job_id = run.record.id

        async def started() -> None:
            await asyncio.wrap_future(
                asyncio.run_coroutine_threadsafe(self._started(job_id), owner)
            )

        status, result, error = JobStatus.DONE, None, None
        try:
            if run.record.cancel_requested:
                raise asyncio.CancelledError()
            run.work = asyncio.ensure_future(
                factory(ExecutionScope(started, execution_id=job_id))
            )
            result = await run.work
        except (asyncio.CancelledError, MirageAbortError):
            # The job's own cancel arrives as CancelledError; the
            # workspace's (a session or workspace cancel) as the abort
            # the line raised.
            status = JobStatus.CANCELED
        except Exception as exc:
            status, error = JobStatus.FAILED, f"{type(exc).__name__}: {exc}"
        if run.record.cancel_requested:
            status, result = JobStatus.CANCELED, None
        run.record = replace(
            run.record,
            status=status,
            result=result if status == JobStatus.DONE else None,
            error=error,
            finished_at=time.time(),
        )
        run.settled.set()
        self._prune()

    async def wait(
        self, job_id: str, timeout: float | None = None
    ) -> JobEntry:
        """The execution once it finishes, or as it stands at the timeout.

        Args:
            job_id (str): the execution.
            timeout (float | None): seconds to wait; None waits for good.
        """
        run = self._runs[job_id]
        try:
            await asyncio.wait_for(
                run.settled.wait(),
                None if timeout is None else max(0, timeout),
            )
        except TimeoutError:
            logger.debug(
                "execution %s still running after %ss", job_id, timeout
            )
        return run.record

    async def join(self, job_id: str) -> JobEntry:
        """Wait for an execution on behalf of the caller that started it.

        A caller cancelled while it waits cancels the execution and waits
        for its cleanup before giving up, so the work never outlives the
        request that started it.

        Args:
            job_id (str): the execution.
        """
        try:
            return await self.wait(job_id)
        except asyncio.CancelledError:
            with anyio.CancelScope(shield=True):
                self.cancel(job_id)
                await self.drain(job_id)
            raise

    def cancel(self, job_id: str) -> bool:
        """Stop an execution and record that it was asked to stop.

        Args:
            job_id (str): execution to cancel.

        Returns:
            bool: whether this call cancelled the execution; False for one
            already finished, or finished and evicted.
        """
        run = self._runs.get(job_id)
        if (
            run is None
            or run.record.finished_at is not None
            or run.record.cancel_requested
        ):
            return False
        run.record = replace(
            run.record, cancel_requested=True, status=JobStatus.STOPPING
        )
        if run.work is not None:
            run.work.cancel()
        return True

    async def drain(self, job_id: str) -> None:
        """Wait for an execution's work and cleanup to settle.

        Args:
            job_id (str): the execution.
        """
        run = self._runs.get(job_id)
        if run is not None and run.completion is not None:
            await settle(run.completion)

    async def close(self) -> None:
        self._closed = True
        if self._closing is None:
            self._closing = asyncio.create_task(self._finish_close())
        await settle(self._closing)

    async def _finish_close(self) -> None:
        runs = list(self._runs.values())
        for run in runs:
            self.cancel(run.record.id)
        await asyncio.gather(
            *(run.completion for run in runs if run.completion is not None)
        )
