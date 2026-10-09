import asyncio
import json
import os
import time
import uuid
from dataclasses import asdict, replace

import pytest
import pytest_asyncio
import redis.asyncio as aioredis

from mirage.execution.redis.store import RedisExecutionStore
from mirage.execution.types import ExecutionRecord, ExecutionStatus

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def stores():
    prefix = f"test:execution:{{{uuid.uuid4().hex}}}:"
    stores = [RedisExecutionStore(REDIS_URL, prefix) for _ in range(2)]
    yield stores
    for store in stores:
        await store.close()
    async with aioredis.from_url(REDIS_URL) as client:
        await client.delete(f"{prefix}records", f"{prefix}completed")


@pytest.mark.asyncio
async def test_atomic_creation_and_revision_races_across_clients(stores):
    first, second = stores
    record = ExecutionRecord(
        "one", "workspace", "session", "echo hi", time.time()
    )
    assert sorted(
        await asyncio.gather(*(s.create(record) for s in stores))
    ) == [False, True]
    canceled = replace(record, revision=1, cancel_requested=True)
    running = replace(record, revision=1, status=ExecutionStatus.RUNNING)
    outcomes = await asyncio.gather(
        first.compare_and_set(canceled, 0), second.compare_and_set(running, 0)
    )
    assert sorted(outcomes) == [False, True]
    winner = canceled if outcomes[0] else running
    assert await first.get(record.id) == await second.get(record.id) == winner
    assert not await first.compare_and_set(replace(winner, revision=8), 0)
    with pytest.raises(ValueError, match="increment the revision"):
        await first.compare_and_set(replace(winner, revision=8), 1)
    with pytest.raises(ValueError, match="identity cannot change"):
        await first.compare_and_set(
            replace(winner, revision=2, session_id="other"), 1
        )
    cancellation = replace(winner, revision=2, cancel_requested=True)
    assert await second.compare_and_set(cancellation, 1)
    with pytest.raises(ValueError, match="cancellation intent"):
        await first.compare_and_set(
            replace(cancellation, revision=3, cancel_requested=False), 2
        )


@pytest.mark.asyncio
async def test_wait_observes_remote_changes_before_and_after_registration(
    stores,
):
    first, second = stores
    record = ExecutionRecord(
        "one", "workspace", "session", "echo hi", time.time()
    )
    await first.create(record)
    waiter = asyncio.create_task(second.wait_for_change(record.id, 0))
    await asyncio.sleep(0.01)
    assert not waiter.done()
    running = replace(record, revision=1, status=ExecutionStatus.RUNNING)
    await first.compare_and_set(running, 0)
    assert await asyncio.wait_for(waiter, 1) == running
    assert await second.wait_for_change(record.id, 0) == running
    assert await second.wait_for_change(record.id, 1, timeout=0.001) == running
    stop = asyncio.Event()
    waiter = asyncio.create_task(
        second.wait_for_change(record.id, 1, cancel=stop)
    )
    stop.set()
    assert await asyncio.wait_for(waiter, 1) == running
    assert await second.wait_for_change("missing", 0) is None


@pytest.mark.asyncio
async def test_terminal_records_wire_schema_and_independent_snapshots(stores):
    first, second = stores
    record = ExecutionRecord(
        "one", "workspace", "session", "echo hé", time.time()
    )
    await first.create(record)
    finished = replace(
        record,
        revision=1,
        status=ExecutionStatus.DONE,
        finished_at=time.time(),
        result={"empty": [], "nested": {}, "stdout": ["hé"]},
    )
    assert await second.compare_and_set(finished, 0)
    assert not await first.compare_and_set(replace(finished, revision=2), 1)
    snapshot = await first.get(record.id)
    snapshot.result["stdout"].append("mutation")
    assert await second.get(record.id) == finished
    assert await first.list("workspace") == [replace(finished, result=None)]
    assert await first.list("other") == []
    async with aioredis.from_url(REDIS_URL) as client:
        raw = await client.hget(f"{first.key_prefix}records", record.id)
        assert json.loads(raw) == asdict(finished)
        assert await client.ttl(f"{first.key_prefix}records") == -1
    await first.close()
    assert await second.get(record.id) == finished


@pytest.mark.asyncio
async def test_retention_prunes_only_completed_including_terminal_creates(
    stores, monkeypatch
):
    first, _ = stores
    retained = RedisExecutionStore(REDIS_URL, first.key_prefix, 2, 10)
    stores.append(retained)
    now = time.time()
    active = ExecutionRecord("active", "other", "session", "sleep", now)
    await retained.create(active)
    for i in range(3):
        record = ExecutionRecord(str(i), "workspace", "session", "echo", now)
        await retained.create(record)
        await retained.compare_and_set(
            replace(
                record,
                revision=1,
                status=ExecutionStatus.DONE,
                finished_at=now + i,
            ),
            0,
        )
    assert await retained.get("0") is None
    assert len(await retained.list("workspace")) == 2
    monkeypatch.setattr(
        "mirage.execution.redis.store.time.time", lambda: now + 13
    )
    assert await retained.list() == [active]
    terminal = replace(
        active, id="already-done", status=ExecutionStatus.DONE, finished_at=now
    )
    await retained.create(terminal)
    assert await retained.get(terminal.id) is None


@pytest.mark.asyncio
async def test_close_wakes_waiters_and_refuses_reconnection(stores):
    first, second = stores
    record = ExecutionRecord(
        "one", "workspace", "session", "sleep", time.time()
    )
    await first.create(record)
    waiter = asyncio.create_task(second.wait_for_change(record.id, 0))
    await asyncio.sleep(0.03)
    await second.close()
    with pytest.raises(RuntimeError, match="closed"):
        await asyncio.wait_for(waiter, 1)
    with pytest.raises(RuntimeError, match="closed"):
        await second.get(record.id)
    assert await first.get(record.id) == record
    await second.close()
