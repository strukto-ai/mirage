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
from mirage.execution.line.types import LineState
from mirage.server.requests import RequestTable
from mirage.vfs.ram import RAMVFS


def submit(table, work, workspace_id="ws"):
    async def run(line):
        await line.start()
        return await work()

    return table.submit(workspace_id, "probe", run, session_id="session")


@pytest.mark.asyncio
async def test_a_request_is_let_go_once_its_caller_has_it():
    table = RequestTable()
    job = submit(table, lambda: asyncio.sleep(0, result="private output"))
    assert table.requests() == [job]
    finished = await table.wait(job.id)
    assert finished.result == "private output"
    assert finished.line.record.state == LineState.EXITED
    assert table.requests() == []
    assert not table.cancel(job.id)
    await table.close()


@pytest.mark.asyncio
async def test_discard_workspace_forgets_only_its_requests():
    table = RequestTable()
    deleted = submit(table, lambda: asyncio.sleep(0), "deleted")
    retained = submit(table, lambda: asyncio.sleep(0), "retained")
    try:
        await table.drain(deleted.id)
        await table.drain(retained.id)
        table.discard_workspace("missing")
        table.discard_workspace("deleted")
        table.discard_workspace("deleted")
        assert table.requests() == [retained]
        with pytest.raises(KeyError):
            await table.wait(deleted.id)
    finally:
        await table.close()


@pytest.mark.asyncio
async def test_the_request_line_reaches_the_workspace_its_history_and_process():
    table = RequestTable()
    ws = Workspace({"/ram": RAMVFS()}, mode=MountMode.WRITE)
    seen = []

    async def run(line):
        seen.append(line.id)
        result = await ws.shell("echo tracked > /ram/file", line_handle=line)
        return result.exit_code

    try:
        job = table.submit(
            "ws", "write", run, session_id=ws.default_session_id
        )
        finished = await table.wait(job.id)
        assert (finished.result, finished.line.record.exit) == (0, 0)
        assert seen == [job.id]
        assert ws.line_table.get(job.id) == finished.line.record
        events = await ws.observer.events()
        assert events and all(
            event.get("id", event.get("parent")) == str(job.id)
            for event in events
        )
    finally:
        await table.close()
        await ws.close()


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

    table = RequestTable()
    job = submit(table, work)
    await asyncio.wait_for(entered.wait(), 2)
    assert job.line.record.state == LineState.RUNNING
    waiter = asyncio.create_task(table.wait(job.id))
    await asyncio.sleep(0)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert table.cancel(job.id)
    await asyncio.wait_for(cleanup.wait(), 2)
    assert job.line.record.state == LineState.STOPPING
    assert job.cancel_requested and job.line.record.ended_at is None
    assert not table.cancel(job.id)
    release.set()
    finished = await table.wait(job.id)
    assert (finished.line.record.signal, finished.line.record.exit) == (2, 130)
    assert not table.cancel(job.id)
    await table.close()


@pytest.mark.asyncio
async def test_cancel_before_start_never_calls_the_body():
    invoked = []

    async def work():
        invoked.append(True)

    table = RequestTable()
    job = submit(table, work)
    assert job.line.record.state == LineState.WAITING
    assert table.cancel(job.id)
    finished = await table.wait(job.id)
    assert finished.line.record.signal == 2
    assert not invoked
    await table.close()


@pytest.mark.asyncio
async def test_command_failure_and_service_failure_are_distinct():
    async def fail():
        raise ValueError("broken runtime")

    table = RequestTable()
    command = submit(table, lambda: asyncio.sleep(0, result={"exit_code": 1}))
    service = submit(table, fail)
    done = await table.wait(command.id)
    failed = await table.wait(service.id)
    assert (done.error, done.result) == (None, {"exit_code": 1})
    assert "broken runtime" in (failed.error or "")
    assert failed.line.record.error == failed.error
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

    table = RequestTable()
    job = submit(table, work)
    joined = asyncio.create_task(table.join(job.id))
    await asyncio.wait_for(entered.wait(), 2)
    joined.cancel()
    with pytest.raises(asyncio.CancelledError):
        await joined
    assert cleaned.is_set()
    assert job.line.record.signal == 2
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

    table = RequestTable()
    job = submit(table, work)
    await asyncio.wait_for(entered.wait(), 2)
    await table.close()
    assert cleaned.is_set()
    assert job.line.record.signal == 2
    with pytest.raises(RuntimeError, match="closed"):
        submit(table, work)
