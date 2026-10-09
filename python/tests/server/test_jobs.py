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

import pytest

from mirage import MountMode, Workspace
from mirage.execution.ram import RAMExecutionStore
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
        job = await table.submit(
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


async def submit(table, work):
    async def run(scope):
        await scope.start()
        return await work()

    return await table.submit("ws", "probe", run, session_id="session")


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
    job = await submit(table, work)
    await asyncio.wait_for(entered.wait(), 2)
    assert (await table.wait(job.id, 0)).status == JobStatus.RUNNING
    waiter = asyncio.create_task(table.wait(job.id))
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert await table.cancel(job.id)
    await asyncio.wait_for(cleanup.wait(), 2)
    current = await table.wait(job.id, 0.01)
    assert current.status == JobStatus.STOPPING
    assert current.cancel_requested and current.finished_at is None
    assert not await table.cancel(job.id)
    release.set()
    assert (await table.wait(job.id)).status == JobStatus.CANCELED
    assert not await table.cancel(job.id)
    await table.close()


@pytest.mark.asyncio
async def test_cancel_before_start_never_calls_the_body():
    invoked = []

    async def work():
        invoked.append(True)

    table = JobTable()
    job = await submit(table, work)
    assert job.status == JobStatus.PENDING
    assert await table.cancel(job.id)
    finished = await table.wait(job.id)
    assert finished.status == JobStatus.CANCELED
    assert finished.started_at is None
    assert not invoked
    await table.close()


@pytest.mark.asyncio
async def test_failed_admission_starts_nothing():
    class BrokenStore(RAMExecutionStore):
        async def create(self, record):
            raise OSError("store unavailable")

    table = JobTable(BrokenStore())
    invoked = []

    async def work():
        invoked.append(True)

    with pytest.raises(OSError, match="unavailable"):
        await submit(table, work)
    assert not invoked


@pytest.mark.asyncio
async def test_cancel_survives_a_delayed_completion_write():
    completing, release = asyncio.Event(), asyncio.Event()

    class DelayedStore(RAMExecutionStore):
        async def compare_and_set(self, record, revision):
            if record.status == JobStatus.DONE:
                completing.set()
                await release.wait()
            return await super().compare_and_set(record, revision)

    table = JobTable(DelayedStore())
    job = await submit(
        table, lambda: asyncio.sleep(0, result={"exit_code": 1})
    )
    await asyncio.wait_for(completing.wait(), 2)
    assert await table.cancel(job.id)
    release.set()
    finished = await table.wait(job.id)
    assert finished.status == JobStatus.CANCELED
    assert finished.cancel_requested
    assert finished.result is None
    assert finished.revision == 3


@pytest.mark.asyncio
async def test_wait_keeps_the_completion_it_observed():
    class EvictingStore(RAMExecutionStore):
        evicted = False

        async def get(self, execution_id):
            return None if self.evicted else await super().get(execution_id)

        async def wait_for_change(self, *args):
            record = await super().wait_for_change(*args)
            self.evicted = (
                record is not None and record.finished_at is not None
            )
            return record

    table = JobTable(EvictingStore())
    job = await submit(table, lambda: asyncio.sleep(0, result="value"))
    finished = await table.wait(job.id)
    assert finished.status == JobStatus.DONE
    assert finished.result == "value"


@pytest.mark.asyncio
async def test_failed_completion_is_unconfirmed_not_successful():
    release = asyncio.Event()

    class BrokenStore(RAMExecutionStore):
        async def compare_and_set(self, record, revision):
            if record.finished_at is not None:
                raise OSError("store unavailable")
            return await super().compare_and_set(record, revision)

    table = JobTable(BrokenStore())
    job = await submit(table, release.wait)
    waiting = asyncio.create_task(table.wait(job.id))
    await asyncio.sleep(0.01)
    release.set()
    with pytest.raises(RuntimeError, match="could not be published"):
        await asyncio.wait_for(waiting, 0.5)
    assert (await table.get(job.id)).finished_at is None


@pytest.mark.asyncio
async def test_command_failure_and_service_failure_are_distinct():
    async def fail():
        raise ValueError("broken runtime")

    table = JobTable()
    command = await submit(
        table, lambda: asyncio.sleep(0, result={"exit_code": 1})
    )
    service = await submit(table, fail)
    assert (await table.wait(command.id)).status == JobStatus.DONE
    assert (await table.wait(service.id)).status == JobStatus.FAILED
    assert "broken runtime" in (await table.get(service.id)).error
    await table.close()


@pytest.mark.asyncio
async def test_shutdown_during_admission_never_schedules_work():
    creating, release = asyncio.Event(), asyncio.Event()

    class DelayedStore(RAMExecutionStore):
        async def create(self, record):
            creating.set()
            await release.wait()
            return await super().create(record)

    store = DelayedStore()
    table = JobTable(store)
    invoked = []

    async def work():
        invoked.append(True)

    submission = asyncio.create_task(submit(table, work))
    await asyncio.wait_for(creating.wait(), 2)
    await table.close()
    release.set()
    with pytest.raises(RuntimeError, match="closed"):
        await submission
    [record] = await store.list()
    assert record.status == JobStatus.CANCELED
    assert record.started_at is None
    assert record.finished_at is not None
    assert not invoked
    await store.close()


@pytest.mark.asyncio
async def test_shutdown_joins_every_runner_even_when_cancel_writes_fail():
    entered, cleanup, release = (
        asyncio.Queue(),
        asyncio.Queue(),
        asyncio.Event(),
    )

    class BrokenStore(RAMExecutionStore):
        async def compare_and_set(self, record, revision):
            if record.status == JobStatus.STOPPING:
                raise OSError("cancel storage unavailable")
            return await super().compare_and_set(record, revision)

    async def work():
        await entered.put(True)
        try:
            await asyncio.Event().wait()
        finally:
            await cleanup.put(True)
            await release.wait()

    store = BrokenStore()
    table = JobTable(store)
    jobs = [await submit(table, work) for _ in range(2)]
    for _ in jobs:
        await asyncio.wait_for(entered.get(), 2)
    closing = asyncio.create_task(table.close())
    for _ in jobs:
        await asyncio.wait_for(cleanup.get(), 2)
    closing.cancel()
    await asyncio.sleep(0)
    assert not closing.done()
    release.set()
    with pytest.raises(ExceptionGroup, match="shutdown cancellation"):
        await closing
    for job in jobs:
        record = await store.get(job.id)
        assert record.status == JobStatus.CANCELED
        assert record.cancel_requested
        assert record.finished_at is not None
    await store.close()


@pytest.mark.asyncio
async def test_store_outage_cannot_prevent_local_cancellation_or_cleanup():
    entered, cleanup, release = (asyncio.Event() for _ in range(3))

    class BrokenStore(RAMExecutionStore):
        offline = False

        async def get(self, execution_id):
            if self.offline:
                raise OSError("storage unavailable")
            return await super().get(execution_id)

    async def work():
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleanup.set()
            await release.wait()

    store = BrokenStore()
    table = JobTable(store)
    job = await submit(table, work)
    await entered.wait()
    store.offline = True
    with pytest.raises(OSError, match="storage unavailable"):
        await table.cancel(job.id)
    await asyncio.wait_for(cleanup.wait(), 1)
    draining = asyncio.create_task(table.drain(job.id))
    with pytest.raises(OSError, match="storage unavailable"):
        await table.cancel(job.id)
    await asyncio.sleep(0)
    assert not draining.done()
    release.set()
    await asyncio.wait_for(draining, 1)
    store.offline = False
    assert (await store.get(job.id)).finished_at is None
    await table.close()
    await store.close()


@pytest.mark.asyncio
async def test_a_stalled_store_cannot_keep_cancelled_work_running():
    entered, cleanup, resume = (asyncio.Event() for _ in range(3))

    class StalledStore(RAMExecutionStore):
        stalled = False

        async def get(self, execution_id):
            if self.stalled:
                await resume.wait()
            return await super().get(execution_id)

    async def work():
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleanup.set()

    store = StalledStore()
    table = JobTable(store)
    job = await submit(table, work)
    await entered.wait()
    store.stalled = True
    cancelling = asyncio.create_task(table.cancel(job.id))
    try:
        await asyncio.wait_for(cleanup.wait(), 1)
        assert not cancelling.done()
    finally:
        resume.set()
    assert await asyncio.wait_for(cancelling, 1)
    assert (await table.wait(job.id)).status == JobStatus.CANCELED
    await table.close()
    await store.close()
