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

import uuid

import pytest

from mirage.observe.store import RAMObserverStore
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.store.ram import RAMWorkspaceStateStore


@pytest.mark.asyncio
async def test_meta_written_on_first_execute():
    store = RAMWorkspaceStateStore()
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   workspace_id="ws-a",
                   store=store)
    await ws.execute("echo hi")
    meta = await store.load_meta("ws-a")
    assert meta is not None
    assert meta["workspace_id"] == "ws-a"
    assert meta["default_session_id"] == ws.default_session_id
    assert uuid.UUID(meta["default_session_id"]).version == 7
    assert meta["created_at"] > 0
    await ws.close()


@pytest.mark.asyncio
async def test_bare_workspace_mints_uuid7_ids():
    ws = Workspace({"/data": RAMResource()}, mode=MountMode.EXEC)
    assert uuid.UUID(ws.workspace_id).version == 7
    assert uuid.UUID(ws.default_session_id).version == 7
    sibling = Workspace({"/data": RAMResource()}, mode=MountMode.EXEC)
    assert sibling.workspace_id != ws.workspace_id
    await ws.close()
    await sibling.close()


@pytest.mark.asyncio
async def test_attach_adopts_stored_default_session():
    """A minted default session id yields to the discovery record's
    pointer, so a fresh attach lands on the writer's default session."""
    store = RAMWorkspaceStateStore()
    ws_a = Workspace({"/data": RAMResource()},
                     mode=MountMode.EXEC,
                     workspace_id="shared",
                     store=store)
    await ws_a.execute("export MARK=1")
    await ws_a.flush_sessions()

    ws_b = Workspace({"/data": RAMResource()},
                     mode=MountMode.EXEC,
                     workspace_id="shared",
                     store=store)
    minted = ws_b.default_session_id
    await ws_b.ensure_sessions_loaded()
    assert ws_b.default_session_id == ws_a.default_session_id
    assert ws_b.default_session_id != minted
    session = ws_b.get_session(ws_b.default_session_id)
    assert session.env.get("MARK") == "1"
    await ws_a.close()
    await ws_b.close()


@pytest.mark.asyncio
async def test_explicit_session_id_is_not_adopted_away():
    store = RAMWorkspaceStateStore()
    ws_a = Workspace({"/data": RAMResource()},
                     mode=MountMode.EXEC,
                     workspace_id="shared",
                     store=store)
    await ws_a.execute("echo hi")

    ws_b = Workspace({"/data": RAMResource()},
                     mode=MountMode.EXEC,
                     workspace_id="shared",
                     session_id="pinned",
                     store=store)
    await ws_b.ensure_sessions_loaded()
    assert ws_b.default_session_id == "pinned"
    await ws_a.close()
    await ws_b.close()


@pytest.mark.asyncio
async def test_existing_meta_wins():
    store = RAMWorkspaceStateStore()
    await store.set_meta("ws-a", {
        "workspace_id": "ws-a",
        "default_session_id": "sess_x",
        "created_at": 1.0
    })
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   workspace_id="ws-a",
                   store=store)
    await ws.execute("echo hi")
    meta = await ws.workspace_meta()
    assert meta["default_session_id"] == "sess_x"
    assert meta["created_at"] == 1.0
    await ws.close()


@pytest.mark.asyncio
async def test_same_workspace_id_shares_sessions():
    store = RAMWorkspaceStateStore()
    ram = RAMResource()
    ws_a = Workspace({"/data": ram},
                     mode=MountMode.EXEC,
                     workspace_id="shared",
                     store=store)
    ws_a.create_session("narrow", mounts={"/data": "read"})
    await ws_a.flush_sessions()

    ws_b = Workspace({"/data": ram},
                     mode=MountMode.EXEC,
                     workspace_id="shared",
                     store=store)
    result = await ws_b.execute("echo blocked > /data/x.txt",
                                session_id="narrow")
    assert result.exit_code != 0
    await ws_a.close()
    await ws_b.close()


@pytest.mark.asyncio
async def test_different_workspace_ids_are_isolated():
    store = RAMWorkspaceStateStore()
    ws_a = Workspace({"/data": RAMResource()},
                     mode=MountMode.EXEC,
                     workspace_id="a",
                     store=store)
    ws_a.create_session("narrow", mounts={"/data": "read"})
    await ws_a.flush_sessions()

    ws_b = Workspace({"/data": RAMResource()},
                     mode=MountMode.EXEC,
                     workspace_id="b",
                     store=store)
    await ws_b.ensure_sessions_loaded()
    assert all(s.session_id != "narrow" for s in ws_b.list_sessions())
    await ws_a.close()
    await ws_b.close()


@pytest.mark.asyncio
async def test_shared_history_through_provider():
    """Two workspaces on one provider + workspace id see one history."""
    store = RAMWorkspaceStateStore()
    ram = RAMResource()
    ws_a = Workspace({"/data": ram},
                     mode=MountMode.EXEC,
                     workspace_id="shared",
                     store=store)
    await ws_a.execute("echo one")

    ws_b = Workspace({"/data": ram},
                     mode=MountMode.EXEC,
                     workspace_id="shared",
                     store=store)
    result = await ws_b.execute("history")
    assert b"echo one" in result.stdout
    await ws_a.close()
    await ws_b.close()


@pytest.mark.asyncio
async def test_plane_override_param_beats_provider():
    """A direct observe= param wins over the provider's observer plane:
    the command never reaches the provider's history."""
    direct = RAMObserverStore()
    store = RAMWorkspaceStateStore()
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   workspace_id="ws-a",
                   store=store,
                   observe=direct)
    await ws.execute("echo hi")

    sibling = Workspace({"/data": RAMResource()},
                        mode=MountMode.EXEC,
                        workspace_id="ws-a",
                        store=store)
    result = await sibling.execute("history")
    assert b"echo hi" not in result.stdout
    await ws.close()
    await sibling.close()
