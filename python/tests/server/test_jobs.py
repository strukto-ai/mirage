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

import pytest

from mirage import MountMode, Workspace
from mirage.server.jobs import JobStatus, JobTable
from mirage.vfs.ram import RAMVFS


@pytest.mark.asyncio
async def test_admitted_record_identity_reaches_workspace_history_and_process():
    table = JobTable()
    ws = Workspace({"/ram": RAMVFS()}, mode=MountMode.WRITE)
    identities = []

    async def run(scope):
        identities.append(scope.id)
        result = await ws.shell(
            "echo tracked > /ram/file", execution_scope=scope
        )
        return result.exit_code

    try:
        job = table.submit(
            "ws", "write", run, session_id=ws.default_session_id
        )
        assert (await table.wait(job.id)).status == JobStatus.DONE
        assert identities == [job.id]
        events = await ws.observer.events()
        assert events and all(
            event.get("execution_id") == job.id for event in events
        )
    finally:
        await table.close()
        await ws.close()


def submit(table, work):
    async def run(scope):
        await scope.start()
        return await work()

    return table.submit("ws", "probe", run, session_id="session")


@pytest.mark.asyncio
async def test_cancel_waits_for_coroutine_cleanup_and_waiter_does_not_own_work():
    entered, cleanup, release = (asyncio.Event() for _ in range(3))

    async def work():
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleanup.set()
            await release.wait()

    table = JobTable()
    job = submit(table, work)
    await asyncio.wait_for(entered.wait(), 2)
    assert (await table.wait(job.id, 0)).status == JobStatus.RUNNING
    waiter = asyncio.create_task(table.wait(job.id))
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert table.cancel(job.id)
    await asyncio.wait_for(cleanup.wait(), 2)
    current = await table.wait(job.id, 0.01)
    assert current.status == JobStatus.STOPPING
    assert current.cancel_requested and current.finished_at is None
    assert not table.cancel(job.id)
    release.set()
    assert (await table.wait(job.id)).status == JobStatus.CANCELED
    assert not table.cancel(job.id)
    await table.close()


@pytest.mark.asyncio
async def test_cancel_before_start_never_calls_the_body():
    invoked = []

    async def work():
        invoked.append(True)

    table = JobTable()
    job = submit(table, work)
    assert job.status == JobStatus.PENDING
    assert table.cancel(job.id)
    finished = await table.wait(job.id)
    assert finished.status == JobStatus.CANCELED
    assert finished.started_at is None
    assert not invoked
    await table.close()


@pytest.mark.asyncio
async def test_command_failure_and_service_failure_are_distinct():
    async def fail():
        raise ValueError("broken runtime")

    table = JobTable()
    command = submit(table, lambda: asyncio.sleep(0, result={"exit_code": 1}))
    service = submit(table, fail)
    assert (await table.wait(command.id)).status == JobStatus.DONE
    assert (await table.wait(service.id)).status == JobStatus.FAILED
    assert "broken runtime" in table.get(service.id).error
    await table.close()


@pytest.mark.asyncio
async def test_a_cancelled_join_cancels_the_work_and_waits_for_cleanup():
    entered, cleaned = asyncio.Event(), asyncio.Event()

    async def work():
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            await asyncio.sleep(0)
            cleaned.set()

    table = JobTable()
    job = submit(table, work)
    joined = asyncio.create_task(table.join(job.id))
    await asyncio.wait_for(entered.wait(), 2)
    joined.cancel()
    with pytest.raises(asyncio.CancelledError):
        await joined
    assert cleaned.is_set()
    assert table.get(job.id).status == JobStatus.CANCELED
    await table.close()


@pytest.mark.asyncio
async def test_close_cancels_running_work_and_joins_it():
    entered, cleaned = asyncio.Event(), asyncio.Event()

    async def work():
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleaned.set()

    table = JobTable()
    job = submit(table, work)
    await asyncio.wait_for(entered.wait(), 2)
    await table.close()
    assert cleaned.is_set()
    assert table.get(job.id).status == JobStatus.CANCELED
    with pytest.raises(RuntimeError, match="closed"):
        submit(table, work)


@pytest.mark.asyncio
async def test_only_the_newest_finished_records_are_kept(monkeypatch):
    monkeypatch.setattr("mirage.server.jobs.MAX_FINISHED_JOBS", 1)
    table = JobTable()
    first = submit(table, lambda: asyncio.sleep(0))
    await table.wait(first.id)
    second = submit(table, lambda: asyncio.sleep(0))
    await table.wait(second.id)
    with pytest.raises(KeyError):
        table.get(first.id)
    assert table.cancel(first.id) is False
    assert [job.id for job in table.list()] == [second.id]
    await table.close()


@pytest.mark.asyncio
async def test_finished_records_expire_after_an_hour(monkeypatch):
    table = JobTable()
    job = submit(table, lambda: asyncio.sleep(0))
    await table.wait(job.id)
    later = time.time() + 3601
    monkeypatch.setattr("mirage.server.jobs.time.time", lambda: later)
    with pytest.raises(KeyError):
        table.get(job.id)
    assert table.list() == []
    await table.close()
