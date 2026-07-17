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

import pytest

from mirage.workspace.store.ram import RAMWorkspaceStateStore


def test_planes_are_cached_per_workspace():
    store = RAMWorkspaceStateStore()
    assert store.namespace("a") is store.namespace("a")
    assert store.observer("a") is store.observer("a")
    assert store.sessions("a") is store.sessions("a")


def test_workspaces_are_isolated():
    store = RAMWorkspaceStateStore()
    assert store.namespace("a") is not store.namespace("b")
    assert store.observer("a") is not store.observer("b")
    assert store.sessions("a") is not store.sessions("b")


@pytest.mark.asyncio
async def test_sessions_plane_isolated_between_workspaces():
    store = RAMWorkspaceStateStore()
    await store.sessions("a").set("s1", {"session_id": "s1"})
    assert await store.sessions("b").load() == {}
    assert set(await store.sessions("a").load()) == {"s1"}


@pytest.mark.asyncio
async def test_meta_roundtrip_and_copies():
    store = RAMWorkspaceStateStore()
    assert await store.load_meta("a") is None
    fields = {"workspace_id": "a", "default_session_id": "default"}
    await store.set_meta("a", fields)
    loaded = await store.load_meta("a")
    assert loaded == fields
    loaded["default_session_id"] = "mutated"
    assert (await store.load_meta("a"))["default_session_id"] == "default"
    await store.close()


@pytest.mark.asyncio
async def test_cas_set_meta_create_if_absent():
    store = RAMWorkspaceStateStore()
    fields = {"workspace_id": "a", "generation": 1}
    assert await store.cas_set_meta("a", fields, 0) is True
    # A second create loses: the record now exists at generation 1.
    assert await store.cas_set_meta("a", {"generation": 1}, 0) is False
    assert (await store.load_meta("a"))["workspace_id"] == "a"


@pytest.mark.asyncio
async def test_cas_set_meta_stale_generation_conflicts():
    store = RAMWorkspaceStateStore()
    await store.set_meta("a", {"workspace_id": "a", "generation": 2})
    lost = {"workspace_id": "a", "generation": 1}
    assert await store.cas_set_meta("a", lost, 0) is False
    assert (await store.load_meta("a"))["generation"] == 2


@pytest.mark.asyncio
async def test_cas_set_meta_legacy_record_counts_as_generation_zero():
    store = RAMWorkspaceStateStore()
    await store.set_meta("a", {"workspace_id": "a"})
    fields = {"workspace_id": "a", "default_session_id": "s", "generation": 1}
    assert await store.cas_set_meta("a", fields, 0) is True
    assert (await store.load_meta("a"))["default_session_id"] == "s"


@pytest.mark.asyncio
async def test_replace_meta_preserves_created_at_and_serializes():
    store = RAMWorkspaceStateStore()
    await store.set_meta(
        "a", {
            "workspace_id": "a",
            "default_session_id": "old",
            "created_at": 1.0,
            "generation": 4,
        })
    written = await store.replace_meta("a", {"default_session_id": "new"})
    assert written["default_session_id"] == "new"
    assert written["created_at"] == 1.0
    assert written["generation"] == 5
    assert await store.load_meta("a") == written


@pytest.mark.asyncio
async def test_replace_meta_creates_when_absent():
    store = RAMWorkspaceStateStore()
    written = await store.replace_meta("a", {
        "workspace_id": "a",
        "default_session_id": "s",
    })
    assert written["generation"] == 1
    assert written["created_at"] > 0
