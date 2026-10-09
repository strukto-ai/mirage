import asyncio
import json
import time
from dataclasses import asdict, replace

import pytest

from mirage.execution.ram import RAMExecutionStore
from mirage.execution.types import ExecutionRecord, ExecutionStatus


@pytest.mark.asyncio
async def test_snapshots_revision_waits_and_terminal_records():
    store = RAMExecutionStore()
    record = ExecutionRecord(
        "one", "workspace", "session", "echo hi", time.time()
    )
    assert await store.create(record)
    assert not await store.create(record)
    waiter = asyncio.create_task(store.wait_for_change(record.id, 0))
    running = replace(record, revision=1, status=ExecutionStatus.RUNNING)
    assert await store.compare_and_set(running, 0)
    assert not await store.compare_and_set(running, 0)
    assert await asyncio.wait_for(waiter, 1) == running
    assert await store.wait_for_change(record.id, 0) == running
    assert await store.wait_for_change(record.id, 1, 0.001) == running
    stop = asyncio.Event()
    stopped = asyncio.create_task(
        store.wait_for_change(record.id, 1, None, stop)
    )
    await asyncio.sleep(0)
    stop.set()
    assert await asyncio.wait_for(stopped, 1) == running
    finished = replace(
        running,
        revision=2,
        status=ExecutionStatus.DONE,
        finished_at=time.time(),
        result={"stdout": ["hi"]},
    )
    assert await store.compare_and_set(finished, 1)
    read = await store.get(record.id)
    json.dumps(asdict(read))
    read.result["stdout"].append("mutation")
    assert (await store.get(record.id)).result == {"stdout": ["hi"]}
    assert (await store.list()) == [replace(finished, result=None)]
    assert not await store.compare_and_set(
        replace(finished, revision=3, status=ExecutionStatus.RUNNING), 2
    )


@pytest.mark.asyncio
async def test_retention_and_workspace_filter_keep_active_records(monkeypatch):
    store = RAMExecutionStore(max_completed=2, retention_seconds=10)
    now = time.time()
    active = ExecutionRecord("active", "other", "same-session", "sleep", now)
    await store.create(active)
    for i in range(3):
        record = ExecutionRecord(
            str(i), "workspace", "same-session", "echo", now
        )
        await store.create(record)
        await store.compare_and_set(
            replace(
                record,
                revision=1,
                status=ExecutionStatus.DONE,
                finished_at=now,
            ),
            0,
        )
    assert await store.get("0") is None
    assert len(await store.list("workspace")) == 2
    monkeypatch.setattr("mirage.execution.ram.time.time", lambda: now + 11)
    assert await store.list() == [active]
    waiting = asyncio.create_task(store.wait_for_change(active.id, 0))
    await asyncio.sleep(0)
    await store.close()
    with pytest.raises(RuntimeError, match="closed"):
        await waiting


@pytest.mark.asyncio
async def test_terminal_creates_share_retention_by_completion_time(
    monkeypatch,
):
    store = RAMExecutionStore(max_completed=2, retention_seconds=10)
    now = time.time()
    active = ExecutionRecord("active", "workspace", "session", "sleep", now)
    await store.create(active)
    for name, finished_at in (
        ("newest", now + 2),
        ("oldest", now),
        ("middle", now + 1),
    ):
        await store.create(
            replace(
                active,
                id=name,
                status=ExecutionStatus.DONE,
                finished_at=finished_at,
            )
        )
    assert await store.get("oldest") is None
    assert {record.id for record in await store.list()} == {
        "active",
        "middle",
        "newest",
    }
    monkeypatch.setattr("mirage.execution.ram.time.time", lambda: now + 11.5)
    assert {record.id for record in await store.list()} == {"active", "newest"}
    await store.create(
        replace(
            active, id="expired", status=ExecutionStatus.DONE, finished_at=now
        )
    )
    assert await store.get("expired") is None
