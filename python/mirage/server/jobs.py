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
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import replace

from mirage.concurrency.limiter import settle
from mirage.execution.base import ExecutionStore
from mirage.execution.ram import RAMExecutionStore
from mirage.execution.types import ExecutionRecord as JobEntry
from mirage.execution.types import ExecutionStatus as JobStatus
from mirage.types import JsonValue
from mirage.workspace.abort import MirageAbortError
from mirage.workspace.execution import ExecutionScope

logger = logging.getLogger(__name__)


def new_job_id() -> str:
    return f"job_{secrets.token_hex(8)}"


class _Run:
    def __init__(self) -> None:
        self.aborted = False
        self.work: asyncio.Task[JsonValue] | None = None
        self.completion: asyncio.Task[None] | None = None
        self.publication_error: Exception | None = None
        self.settled = asyncio.Event()

    def abort(self) -> None:
        self.aborted = True
        if self.work is not None:
            self.work.cancel()


class JobTable:
    """Local execution owner over an asynchronous record store.

    Submit persists admission before any work starts. A shell marks running
    only after acquiring its session. Cancellation is an intent; completion
    is published after the work and its cleanup settle.
    """

    def __init__(self, store: ExecutionStore | None = None) -> None:
        self.store = store if store is not None else RAMExecutionStore()
        self._owns_store = store is None
        self._live: dict[str, _Run] = {}
        self._closed = False
        self._closing: asyncio.Task[None] | None = None

    async def get(self, job_id: str) -> JobEntry:
        entry = await self.store.get(job_id)
        if entry is None:
            raise KeyError(job_id)
        return entry

    async def list(self, workspace_id: str | None = None) -> list[JobEntry]:
        return await self.store.list(workspace_id)

    async def _change(
        self, job_id: str, update: Callable[[JobEntry], JobEntry | None]
    ) -> tuple[JobEntry, bool]:
        for _ in range(32):
            current = await self.get(job_id)
            replacement = update(current)
            if replacement is None or current.finished_at is not None:
                return current, False
            replacement = replace(replacement, revision=current.revision + 1)
            if await self.store.compare_and_set(replacement, current.revision):
                return replacement, True
        raise RuntimeError("execution record changed too often")

    async def _started(self, job_id: str) -> None:
        record, _ = await self._change(
            job_id,
            lambda r: (
                None
                if r.cancel_requested
                else replace(
                    r, status=JobStatus.RUNNING, started_at=time.time()
                )
            ),
        )
        if record.cancel_requested or record.finished_at is not None:
            raise asyncio.CancelledError()

    async def submit(
        self,
        workspace_id: str,
        command: str,
        factory: Callable[[ExecutionScope], Awaitable[JsonValue]],
        *,
        session_id: str,
    ) -> JobEntry:
        if self._closed:
            raise RuntimeError("job table is closed")
        record = JobEntry(
            new_job_id(), workspace_id, session_id, command, time.time()
        )
        if not await self.store.create(record):
            raise RuntimeError("duplicate execution id")
        if self._closed:
            await self._change(
                record.id,
                lambda r: replace(
                    r,
                    status=JobStatus.CANCELED,
                    cancel_requested=True,
                    finished_at=time.time(),
                ),
            )
            raise RuntimeError("job table is closed")
        control = _Run()
        self._live[record.id] = control
        control.completion = asyncio.create_task(
            self._run(record.id, control, factory)
        )
        return record

    async def _run(
        self,
        job_id: str,
        control: _Run,
        factory: Callable[[ExecutionScope], Awaitable[JsonValue]],
    ) -> None:
        owner = asyncio.get_running_loop()

        async def started() -> None:
            await asyncio.wrap_future(
                asyncio.run_coroutine_threadsafe(self._started(job_id), owner)
            )

        status, result, error = JobStatus.DONE, None, None
        try:
            if control.aborted:
                raise asyncio.CancelledError()
            control.work = asyncio.ensure_future(
                factory(ExecutionScope(started))
            )
            result = await control.work
        except (asyncio.CancelledError, MirageAbortError):
            # The job's own cancel arrives as CancelledError; the
            # workspace's (a session or workspace cancel) as the abort
            # the line raised.
            status = JobStatus.CANCELED
        except Exception as exc:
            status, error = JobStatus.FAILED, f"{type(exc).__name__}: {exc}"
        try:
            await self._change(
                job_id,
                lambda r: replace(
                    r,
                    status=JobStatus.CANCELED
                    if r.cancel_requested or control.aborted
                    else status,
                    result=result
                    if status == JobStatus.DONE
                    and not r.cancel_requested
                    and not control.aborted
                    else None,
                    error=error,
                    cancel_requested=r.cancel_requested or control.aborted,
                    finished_at=time.time(),
                ),
            )
        except Exception as exc:
            control.publication_error = exc
            logger.exception("could not publish completion of %s", job_id)
        else:
            self._live.pop(job_id, None)
        finally:
            control.settled.set()

    async def wait(
        self, job_id: str, timeout: float | None = None
    ) -> JobEntry:
        deadline = (
            None if timeout is None else time.monotonic() + max(0, timeout)
        )
        entry = await self.get(job_id)
        control = self._live.get(job_id)
        while entry.finished_at is None:
            if control is not None and control.publication_error is not None:
                raise RuntimeError(
                    "execution completion could not be published"
                ) from control.publication_error
            remaining = (
                None if deadline is None else deadline - time.monotonic()
            )
            if remaining is not None and remaining <= 0:
                break
            changed = await self.store.wait_for_change(
                job_id,
                entry.revision,
                remaining,
                None if control is None else control.settled,
            )
            if changed is None:
                raise KeyError(job_id)
            entry = changed
        return entry

    async def cancel(self, job_id: str) -> bool:
        _, accepted = await self._change(
            job_id,
            lambda r: (
                None
                if r.cancel_requested
                else replace(
                    r, cancel_requested=True, status=JobStatus.STOPPING
                )
            ),
        )
        if accepted:
            control = self._live.get(job_id)
            if control is not None:
                control.abort()
        return accepted

    async def close(self) -> None:
        self._closed = True
        if self._closing is None:
            self._closing = asyncio.create_task(self._finish_close())
        await settle(self._closing)

    async def _finish_close(self) -> None:
        controls = list(self._live.items())
        errors: list[Exception] = []
        for _, control in controls:
            control.abort()
        for job_id, control in controls:
            try:
                await self.cancel(job_id)
            except Exception as exc:
                errors.append(exc)
        await asyncio.gather(
            *(c.completion for _, c in controls if c.completion is not None)
        )
        if self._owns_store:
            await self.store.close()
        if errors:
            raise ExceptionGroup(
                "could not record shutdown cancellation", errors
            )
