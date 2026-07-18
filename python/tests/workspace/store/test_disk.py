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

from mirage.workspace.store.disk import DiskWorkspaceStateStore


@pytest.mark.asyncio
async def test_meta_roundtrip_and_layout(tmp_path):
    store = DiskWorkspaceStateStore(str(tmp_path))
    assert await store.load_meta("ws1") is None
    await store.set_meta("ws1", {"workspace_id": "ws1", "generation": 1})
    meta = await store.load_meta("ws1")
    assert meta is not None and meta["workspace_id"] == "ws1"
    assert (tmp_path / "workspaces" / "ws1" / "workspace.json").is_file()
    await store.close()


@pytest.mark.asyncio
async def test_meta_cas_contract(tmp_path):
    store = DiskWorkspaceStateStore(str(tmp_path))
    assert await store.cas_set_meta("ws1", {
        "workspace_id": "ws1",
        "generation": 1
    }, 0) is True
    assert await store.cas_set_meta("ws1", {
        "workspace_id": "ws1",
        "generation": 1
    }, 0) is False
    assert await store.cas_set_meta("ws1", {
        "workspace_id": "ws1",
        "default_session_id": "d",
        "generation": 2
    }, 1) is True
    meta = await store.load_meta("ws1")
    assert meta is not None and meta["default_session_id"] == "d"
    await store.close()


@pytest.mark.asyncio
async def test_replace_meta_preserves_created_at(tmp_path):
    store = DiskWorkspaceStateStore(str(tmp_path))
    first = await store.replace_meta("ws1", {"workspace_id": "ws1"})
    second = await store.replace_meta("ws1", {
        "workspace_id": "ws1",
        "default_session_id": "d"
    })
    assert second["created_at"] == first["created_at"]
    assert second["generation"] == first["generation"] + 1
    await store.close()


@pytest.mark.asyncio
async def test_sessions_scoped_per_workspace(tmp_path):
    store = DiskWorkspaceStateStore(str(tmp_path))
    await store.sessions("ws1").set("s", {"session_id": "s", "cwd": "/a"})
    await store.sessions("ws2").set("s", {"session_id": "s", "cwd": "/b"})
    assert (await store.sessions("ws1").load())["s"]["cwd"] == "/a"
    assert (await store.sessions("ws2").load())["s"]["cwd"] == "/b"
    assert (tmp_path / "workspaces" / "ws1" / "sessions" / "s.json").is_file()
    assert (tmp_path / "workspaces" / "ws2" / "sessions" / "s.json").is_file()
    await store.close()


@pytest.mark.asyncio
async def test_namespace_and_observer_planes_on_disk(tmp_path):
    store = DiskWorkspaceStateStore(str(tmp_path))
    ns = store.namespace("ws1")
    await ns.set("/link.txt", {"target": "/a.txt"})
    assert (await ns.load())["/link.txt"] == {"target": "/a.txt"}
    assert (tmp_path / "workspaces" / "ws1" / "namespace.json").is_file()
    ob = store.observer("ws1")
    await ob.append("/2026-07-18/agent.jsonl", b'{"type": "COMMAND"}\n')
    files = await ob.read_all()
    assert (tmp_path / "workspaces" / "ws1" / "history" / "2026-07-18" /
            "agent.jsonl").is_file()
    assert files["/2026-07-18/agent.jsonl"] == b'{"type": "COMMAND"}\n'
    await store.close()


@pytest.mark.asyncio
async def test_two_stores_share_state_via_the_directory(tmp_path):
    writer = DiskWorkspaceStateStore(str(tmp_path))
    await writer.set_meta("ws1", {"workspace_id": "ws1", "generation": 1})
    await writer.sessions("ws1").set("s", {"session_id": "s", "cwd": "/x"})
    await writer.close()

    reader = DiskWorkspaceStateStore(str(tmp_path))
    meta = await reader.load_meta("ws1")
    assert meta is not None and meta["generation"] == 1
    assert (await reader.sessions("ws1").load())["s"]["cwd"] == "/x"
    await reader.close()
