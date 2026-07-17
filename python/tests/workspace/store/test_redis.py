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

import os
import uuid

import pytest
import pytest_asyncio
import redis.asyncio as aioredis

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.store.redis import RedisWorkspaceStateStore

REDIS_URL = os.environ.get("REDIS_URL")

pytestmark = pytest.mark.skipif(REDIS_URL is None,
                                reason="REDIS_URL not configured")


@pytest.fixture
def prefix() -> str:
    return f"mirage:test:store:{uuid.uuid4().hex[:8]}:"


@pytest_asyncio.fixture
async def store(prefix):
    s = RedisWorkspaceStateStore(url=REDIS_URL, key_prefix=prefix)
    yield s
    client = aioredis.from_url(REDIS_URL)
    keys = [key async for key in client.scan_iter(f"{prefix}*")]
    if keys:
        await client.delete(*keys)
    await client.aclose()
    await s.close()


@pytest.mark.asyncio
async def test_key_layout_scoped_by_workspace(prefix, store):
    await store.sessions("ws1").set("s1", {"session_id": "s1"})
    await store.namespace("ws1").set("/a", {"mode": 0o600})
    await store.set_meta("ws1", {"workspace_id": "ws1"})
    client = aioredis.from_url(REDIS_URL)
    keys = {key.decode() async for key in client.scan_iter(f"{prefix}*")}
    await client.aclose()
    assert f"{prefix}ws1:sessions" in keys
    assert f"{prefix}ws1:namespace:nodes" in keys
    assert f"{prefix}workspaces" in keys


@pytest.mark.asyncio
async def test_meta_visible_across_providers(prefix, store):
    await store.set_meta("ws1", {
        "workspace_id": "ws1",
        "default_session_id": "default"
    })
    sibling = RedisWorkspaceStateStore(url=REDIS_URL, key_prefix=prefix)
    try:
        meta = await sibling.load_meta("ws1")
        assert meta is not None
        assert meta["default_session_id"] == "default"
        assert await sibling.load_meta("other") is None
    finally:
        await sibling.close()


@pytest.mark.asyncio
async def test_cas_set_meta_create_race_one_winner(prefix, store):
    """Two providers race the discovery-record create; exactly one
    conditional write lands and the loser sees the winner's record."""
    sibling = RedisWorkspaceStateStore(url=REDIS_URL, key_prefix=prefix)
    try:
        mine = {
            "workspace_id": "ws1",
            "default_session_id": "a",
            "generation": 1
        }
        theirs = {
            "workspace_id": "ws1",
            "default_session_id": "b",
            "generation": 1
        }
        assert await store.cas_set_meta("ws1", mine, 0) is True
        assert await sibling.cas_set_meta("ws1", theirs, 0) is False
        loaded = await sibling.load_meta("ws1")
        assert loaded is not None
        assert loaded["default_session_id"] == "a"
    finally:
        await sibling.close()


@pytest.mark.asyncio
async def test_cas_set_meta_stale_generation_conflicts(store):
    await store.set_meta("ws1", {"workspace_id": "ws1", "generation": 2})
    lost = {"workspace_id": "ws1", "generation": 1}
    assert await store.cas_set_meta("ws1", lost, 0) is False
    meta = await store.load_meta("ws1")
    assert meta is not None
    assert meta["generation"] == 2


@pytest.mark.asyncio
async def test_replace_meta_serializes_over_the_wire(store):
    await store.set_meta(
        "ws1", {
            "workspace_id": "ws1",
            "default_session_id": "old",
            "created_at": 1.0,
            "generation": 4,
        })
    written = await store.replace_meta("ws1", {"default_session_id": "new"})
    assert written["generation"] == 5
    assert written["created_at"] == 1.0
    loaded = await store.load_meta("ws1")
    assert loaded == written


@pytest.mark.asyncio
async def test_workspace_discovery_and_session_sharing(prefix):
    """The kernel-tier flow: one process runs a workspace, a sibling
    with only the store config + workspace id finds its default
    session and reads its session table."""
    store_a = RedisWorkspaceStateStore(url=REDIS_URL, key_prefix=prefix)
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   workspace_id="agent-ws",
                   store=store_a)
    store_b = RedisWorkspaceStateStore(url=REDIS_URL, key_prefix=prefix)
    try:
        ws.create_session("narrow", mounts={"/data": "read"})
        await ws.ensure_sessions_loaded()
        await ws.flush_sessions()

        meta = await store_b.load_meta("agent-ws")
        assert meta is not None
        assert meta["default_session_id"] == ws.default_session_id
        sessions = await store_b.sessions("agent-ws").load()
        assert sessions["narrow"]["mount_modes"]["/data"] == "read"
    finally:
        await ws.close()
        await store_a.close()
        await store_b.close()
