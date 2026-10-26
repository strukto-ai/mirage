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
import os
import uuid

import pytest
import pytest_asyncio
import redis.asyncio as aioredis

from mirage.io import IOResult
from mirage.shell.console import Channel
from mirage.shell.job_table.redis import RedisJobStore
from mirage.shell.job_table.table import JobTable
from mirage.shell.job_table.types import Job, JobStatus
from mirage.workspace.types import ExecutionNode

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest.fixture()
def prefix() -> str:
    return f"test:jobs:{uuid.uuid4().hex}:"


@pytest_asyncio.fixture()
async def stores(prefix):
    opened: list[RedisJobStore] = []

    def open_store(lease_seconds: float | None = 30.0) -> RedisJobStore:
        store = RedisJobStore(
            url=REDIS_URL, key_prefix=prefix, lease_seconds=lease_seconds
        )
        opened.append(store)
        return store

    yield open_store
    await opened[0].clear()
    for store in opened:
        await store.close()


async def _run_forever(job: Job) -> tuple[IOResult, ExecutionNode]:
    """A runner that never finishes on its own.

    Args:
        job (Job): the job being run.
    """
    await asyncio.Event().wait()
    return IOResult(), ExecutionNode()


@pytest.mark.asyncio
async def test_a_list_is_written_under_its_generation(stores):
    store = stores()
    assert await store.load("s") is None
    assert await store.cas_set("s", {"next": 2, "generation": 1}, 0)
    assert not await store.cas_set("s", {"next": 3, "generation": 1}, 0)
    assert await store.load("s") == {"next": 2, "generation": 1}
    assert not await store.delete("s", 0)
    assert await store.load("s") == {"next": 2, "generation": 1}
    assert await store.delete("s", 1)
    assert await store.load("s") is None


@pytest.mark.asyncio
async def test_a_console_name_reaches_one_stream_from_any_store(stores):
    first, second = stores(), stores()
    await first.console("c").append(Channel.STDOUT, b"hi")
    chunks, _, _ = await second.console("c").read_from(0)
    assert [c.data for c in chunks] == [b"hi"]


@pytest.mark.asyncio
async def test_an_owner_lives_while_its_lease_holds(stores):
    store = stores(lease_seconds=0.2)
    assert not await store.alive("o")
    await store.renew("o")
    assert await store.alive("o")
    await asyncio.sleep(0.3)
    assert not await store.alive("o")


@pytest.mark.asyncio
async def test_clear_drops_lists_consoles_and_leases(stores, prefix):
    store = stores()
    await store.cas_set("s", {"generation": 1}, 0)
    await store.console("c").append(Channel.STDOUT, b"x")
    await store.renew("o")
    await store.clear()
    assert await store.load("s") is None
    assert [k async for k in store._client.scan_iter(f"{prefix}*")] == []


@pytest.mark.asyncio
async def test_a_table_on_another_store_kills_and_waits_on_a_job(stores):
    a, b = JobTable(stores()), JobTable(stores())
    job = await a.submit("sleep 30", _run_forever, "/", session_id="s")
    await b.sync("s")
    assert [j.status for j in b.list_jobs("s")] == [JobStatus.RUNNING]
    assert await b.kill(1, "s", 15)
    assert (await b.wait(1, "s")).exit_code == 143
    assert job.process is not None
    async with asyncio.timeout(5):
        await job.process.join()
    assert (job.status, job.exit_code) == (JobStatus.KILLED, 143)
    await a.close()


@pytest.mark.asyncio
async def test_a_job_whose_owner_died_ends_as_hung_up(stores):
    a = JobTable(stores(lease_seconds=0.3))
    b = JobTable(stores(lease_seconds=0.3))
    await a.submit("sleep 30", _run_forever, "/", session_id="s")
    assert a._lease is not None
    a._lease.cancel()
    await b.sync("s")
    async with asyncio.timeout(5):
        assert (await b.wait(1, "s")).exit_code == 129
    await a.kill_all()


@pytest.mark.asyncio
async def test_a_renewal_keeps_a_running_jobs_console(stores, prefix):
    store = stores()
    await store.console("c").append(Channel.STDOUT, b"x")
    client = aioredis.from_url(REDIS_URL)
    try:
        await client.expire(f"{prefix}console:c:stream", 5)
        await store.renew("o", ["c"])
        assert await client.ttl(f"{prefix}console:c:stream") > 5
    finally:
        await client.aclose()
