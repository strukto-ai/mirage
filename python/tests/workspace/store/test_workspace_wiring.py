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
import uuid

import pytest

from mirage.cache.file.ram import RAMFileCacheStore
from mirage.observe.store import RAMObserverStore
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.store.base import WorkspaceFields
from mirage.workspace.store.ram import RAMWorkspaceStateStore


class ClosingStore(RAMWorkspaceStateStore):

    def __init__(self) -> None:
        super().__init__()
        self.closed = False

    async def _close(self) -> None:
        self.closed = True


class ClosingCache(RAMFileCacheStore):

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.close_calls = 0

    async def close(self) -> None:
        self.close_calls += 1


class YieldingStore(RAMWorkspaceStateStore):
    """Yields to the event loop on meta reads so two concurrent
    attaches both observe the record as absent before either writes."""

    async def _load_meta(self, workspace_id: str) -> WorkspaceFields | None:
        await asyncio.sleep(0)
        return await super()._load_meta(workspace_id)


@pytest.mark.asyncio
async def test_workspace_closes_owned_passed_store():
    store = ClosingStore()
    ws = Workspace({"/data": RAMResource()}, store=store, owns_store=True)
    await ws.close()
    assert store.closed


@pytest.mark.asyncio
async def test_workspace_does_not_close_shared_passed_store():
    store = ClosingStore()
    ws = Workspace({"/data": RAMResource()}, store=store)
    await ws.close()
    assert not store.closed


@pytest.mark.asyncio
async def test_workspace_closes_its_cache_once(monkeypatch):
    monkeypatch.setattr("mirage.workspace.workspace.cache.RAMFileCacheStore",
                        ClosingCache)
    ws = Workspace({"/data": RAMResource()})
    cache = ws.cache

    await ws.close()
    await ws.close()

    assert cache.close_calls == 1


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
@pytest.mark.parametrize("target", ["default", "named"])
async def test_profile_change_targets_the_session_after_hydration(target):
    store = RAMWorkspaceStateStore()
    writer = Workspace({}, workspace_id="shared", store=store)
    writer.create_session("named")
    await writer.ensure_sessions_loaded()
    await writer.flush_sessions()
    attached = Workspace({}, workspace_id="shared", store=store)
    provisional = attached.default_session_id
    requested = provisional if target == "default" else "named"
    expected = writer.default_session_id if target == "default" else "named"
    try:
        session = await attached.set_session_profile(
            requested, {"commands": {
                "allow": ["cat"]
            }})
        assert session.session_id == expected
        assert attached.default_session_id == writer.default_session_id
        assert attached.default_session_id != provisional
        assert session.commands.allow == ("cat", )
        persisted = await store.sessions("shared").load()
        assert persisted[expected]["commands"]["allow"] == ["cat"]
    finally:
        await writer.close()
        await attached.close()


@pytest.mark.asyncio
async def test_profile_change_refuses_shutdown_during_hydration(monkeypatch):
    store = RAMWorkspaceStateStore()
    ws = Workspace({}, workspace_id="shared", store=store)
    entered = asyncio.Event()
    release = asyncio.Event()
    sessions = store.sessions("shared")
    load = sessions.load

    async def blocked_load():
        entered.set()
        await release.wait()
        return await load()

    monkeypatch.setattr(sessions, "load", blocked_load)
    session = ws.get_session(ws.default_session_id)
    commands = session.commands
    changing = asyncio.create_task(
        ws.set_session_profile(ws.default_session_id,
                               {"commands": {
                                   "allow": ["cat"]
                               }}))
    try:
        await asyncio.wait_for(entered.wait(), timeout=5)
        await ws.close()
    finally:
        release.set()
        await asyncio.gather(changing, return_exceptions=True)
        await ws.close()
    with pytest.raises(RuntimeError, match="Workspace is closed"):
        await changing
    assert session.commands is commands
    assert await load() == {}


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
async def test_concurrent_attach_single_discovery_record():
    """Two processes attach the same fresh workspace id at once: the
    CAS create admits exactly one discovery record and the loser adopts
    the winner's default session instead of clobbering the pointer."""
    store = YieldingStore()
    ram = RAMResource()
    ws_a = Workspace({"/data": ram},
                     mode=MountMode.EXEC,
                     workspace_id="ws-a",
                     store=store)
    ws_b = Workspace({"/data": ram},
                     mode=MountMode.EXEC,
                     workspace_id="ws-a",
                     store=store)
    await asyncio.gather(ws_a.ensure_sessions_loaded(),
                         ws_b.ensure_sessions_loaded())
    meta = await store.load_meta("ws-a")
    assert meta is not None
    assert meta["generation"] == 1
    assert ws_a.default_session_id == ws_b.default_session_id
    assert meta["default_session_id"] == ws_a.default_session_id
    await ws_a.close()
    await ws_b.close()


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
