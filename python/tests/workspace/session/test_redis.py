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

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.session.redis import RedisSessionStore
from mirage.workspace.session.store import SessionStore


async def cas_increment(store: SessionStore, worker: str, rounds: int) -> None:
    """Read-modify-CAS one counter, retrying until each round lands."""
    for _ in range(rounds):
        for _ in range(200):
            record = (await store.load()).get("hot", {
                "session_id": "hot",
                "env": {},
            })
            env = dict(record.get("env", {}))
            env[worker] = str(int(env.get(worker, "0")) + 1)
            expected = int(record.get("generation", 0))
            fields = dict(record)
            fields["env"] = env
            fields["generation"] = expected + 1
            if await store.cas_set("hot", fields, expected):
                break
        else:
            raise AssertionError("cas retry budget exhausted")


REDIS_URL = os.environ.get("REDIS_URL")

pytestmark = pytest.mark.skipif(REDIS_URL is None,
                                reason="REDIS_URL not configured")


@pytest.fixture
def prefix() -> str:
    return f"mirage:test:session:{uuid.uuid4().hex[:8]}:"


@pytest_asyncio.fixture
async def store(prefix):
    s = RedisSessionStore(url=REDIS_URL, key_prefix=prefix)
    yield s
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_set_load_roundtrip(store):
    await store.set("s1", {"session_id": "s1", "cwd": "/a", "env": {}})
    await store.set(
        "s2", {
            "session_id": "s2",
            "cwd": "/",
            "env": {
                "K": "v"
            },
            "mount_modes": {
                "/data": "read"
            }
        })
    entries = await store.load()
    assert entries["s1"]["cwd"] == "/a"
    assert entries["s2"]["mount_modes"] == {"/data": "read"}


@pytest.mark.asyncio
async def test_delete_and_replace_all(store):
    await store.set("a", {"session_id": "a"})
    await store.set("b", {"session_id": "b"})
    await store.delete(["a", "missing"])
    assert set(await store.load()) == {"b"}
    await store.replace_all({"c": {"session_id": "c"}})
    assert set(await store.load()) == {"c"}


@pytest.mark.asyncio
async def test_sessions_shared_across_workspaces(prefix):
    """A session created by one workspace is visible to a sibling
    pointed at the same key prefix, with its mount grants intact."""
    store_a = RedisSessionStore(url=REDIS_URL, key_prefix=prefix)
    store_b = RedisSessionStore(url=REDIS_URL, key_prefix=prefix)
    ws_a = Workspace({"/data": RAMResource()},
                     mode=MountMode.EXEC,
                     session_store=store_a)
    ws_b = Workspace({"/data": RAMResource()},
                     mode=MountMode.EXEC,
                     session_store=store_b)
    try:
        ws_a.create_session("narrow", mounts={"/data": "read"})
        await ws_a.flush_sessions()
        await ws_b.ensure_sessions_loaded()
        session = ws_b.get_session("narrow")
        assert session.mount_modes is not None
        assert session.mount_modes["/data"] == MountMode.READ
    finally:
        await store_a.clear()
        await ws_a.close()
        await ws_b.close()


@pytest.mark.asyncio
async def test_cas_set_matching_generation_writes(store):
    fields = {"session_id": "s1", "cwd": "/", "env": {}, "generation": 1}
    assert await store.cas_set("s1", fields, 0) is True
    assert (await store.load())["s1"]["generation"] == 1


@pytest.mark.asyncio
async def test_cas_set_stale_generation_conflicts(store):
    await store.set("s1", {"session_id": "s1", "cwd": "/", "generation": 2})
    lost = {"session_id": "s1", "cwd": "/stale", "generation": 1}
    assert await store.cas_set("s1", lost, 0) is False
    assert (await store.load())["s1"]["cwd"] == "/"


@pytest.mark.asyncio
async def test_cas_set_legacy_record_counts_as_generation_zero(store):
    await store.set("s1", {"session_id": "s1", "cwd": "/old"})
    fields = {"session_id": "s1", "cwd": "/new", "generation": 1}
    assert await store.cas_set("s1", fields, 0) is True
    assert (await store.load())["s1"]["cwd"] == "/new"


@pytest.mark.asyncio
async def test_cas_concurrent_writers_lose_no_updates(store):
    """Five concurrent writers race one record; every increment must
    survive and the generation must equal the exact write count."""
    await asyncio.gather(*(cas_increment(store, f"w{i}", 10)
                           for i in range(5)))
    final = (await store.load())["hot"]
    assert final["generation"] == 50
    assert final["env"] == {f"w{i}": "10" for i in range(5)}


@pytest.mark.asyncio
async def test_cas_serializes_two_writers(prefix):
    writer_a = RedisSessionStore(url=REDIS_URL, key_prefix=prefix)
    writer_b = RedisSessionStore(url=REDIS_URL, key_prefix=prefix)
    try:
        first = {"session_id": "s", "cwd": "/a", "generation": 1}
        second = {"session_id": "s", "cwd": "/b", "generation": 1}
        assert await writer_a.cas_set("s", first, 0) is True
        assert await writer_b.cas_set("s", second, 0) is False
        retried = {"session_id": "s", "cwd": "/b", "generation": 2}
        assert await writer_b.cas_set("s", retried, 1) is True
        assert (await writer_a.load())["s"]["cwd"] == "/b"
    finally:
        await writer_a.clear()
        await writer_a.close()
        await writer_b.close()
