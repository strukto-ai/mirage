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

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.session import RAMSessionStore, SessionManager


def _run(coro):
    return asyncio.run(coro)


def test_manager_default_session():
    mgr = SessionManager("default")
    s = mgr.get("default")
    assert s.session_id == "default"


def test_manager_default_cwd():
    mgr = SessionManager("default")
    assert mgr.cwd == "/"
    mgr.cwd = "/data"
    assert mgr.cwd == "/data"
    assert mgr.get("default").cwd == "/data"


def test_manager_default_env():
    mgr = SessionManager("default")
    assert mgr.env == {}
    mgr.env = {"A": "1"}
    assert mgr.env == {"A": "1"}
    assert mgr.get("default").env == {"A": "1"}


def test_manager_create_session():
    mgr = SessionManager("default")
    s = mgr.create("worker-1")
    assert s.session_id == "worker-1"
    assert mgr.get("worker-1") is s


def test_manager_create_duplicate_raises():
    mgr = SessionManager("default")
    mgr.create("s1")
    with pytest.raises(ValueError, match="already exists"):
        mgr.create("s1")


def test_manager_get_missing_raises():
    mgr = SessionManager("default")
    with pytest.raises(KeyError):
        mgr.get("nonexistent")


def test_manager_list_sessions():
    mgr = SessionManager("default")
    mgr.create("s1")
    mgr.create("s2")
    sessions = mgr.list()
    ids = {s.session_id for s in sessions}
    assert ids == {"default", "s1", "s2"}


def test_manager_close_session():
    mgr = SessionManager("default")
    mgr.create("temp")
    _run(mgr.close("temp"))
    with pytest.raises(KeyError):
        mgr.get("temp")


def test_manager_close_default_raises():
    mgr = SessionManager("default")
    with pytest.raises(ValueError, match="Cannot close"):
        _run(mgr.close("default"))


def test_manager_close_missing_raises():
    mgr = SessionManager("default")
    with pytest.raises(KeyError):
        _run(mgr.close("nonexistent"))


def test_manager_close_all():
    mgr = SessionManager("default")
    mgr.create("s1")
    mgr.create("s2")
    _run(mgr.close_all())
    sessions = mgr.list()
    assert len(sessions) == 1
    assert sessions[0].session_id == "default"


def test_manager_sessions_isolated():
    mgr = SessionManager("default")
    s1 = mgr.create("s1")
    s2 = mgr.create("s2")
    s1.env["X"] = "from-s1"
    s1.cwd = "/s1"
    assert "X" not in s2.env
    assert s2.cwd == "/"


def test_manager_lock_for():
    mgr = SessionManager("default")
    lock = mgr.lock_for("default")
    assert lock is not None

    mgr.create("s1")
    lock2 = mgr.lock_for("s1")
    assert lock2 is not lock


def test_manager_create_with_mount_modes():
    mgr = SessionManager("default")
    grants = {"/s3": MountMode.READ, "/slack": MountMode.WRITE}
    s = mgr.create("agent", mount_modes=grants)
    assert s.mount_modes == grants


def test_manager_create_default_unrestricted():
    mgr = SessionManager("default")
    s = mgr.create("worker")
    assert s.mount_modes is None


@pytest.mark.asyncio
async def test_manager_hydrates_from_store():
    store = RAMSessionStore()
    await store.set(
        "restored", {
            "session_id": "restored",
            "cwd": "/w",
            "env": {
                "K": "v"
            },
            "created_at": 1.0,
            "mount_modes": {
                "/data": "read"
            }
        })
    mgr = SessionManager("default", store=store)
    await mgr.ensure_loaded()
    s = mgr.get("restored")
    assert s.cwd == "/w"
    assert s.env == {"K": "v"}
    assert s.mount_modes == {"/data": MountMode.READ}


@pytest.mark.asyncio
async def test_manager_hydration_local_wins():
    store = RAMSessionStore()
    await store.set("s1", {"session_id": "s1", "cwd": "/stale"})
    mgr = SessionManager("default", store=store)
    local = mgr.create("s1")
    local.cwd = "/fresh"
    await mgr.ensure_loaded()
    assert mgr.get("s1").cwd == "/fresh"


@pytest.mark.asyncio
async def test_manager_default_adopts_stored_fields():
    store = RAMSessionStore()
    await store.set("default", {
        "session_id": "default",
        "cwd": "/w",
        "env": {
            "A": "1"
        }
    })
    mgr = SessionManager("default", store=store)
    await mgr.ensure_loaded()
    assert mgr.cwd == "/w"
    assert mgr.env == {"A": "1"}


@pytest.mark.asyncio
async def test_manager_flush_writes_through():
    store = RAMSessionStore()
    mgr = SessionManager("default", store=store)
    mgr.create("agent", mount_modes={"/s3": MountMode.READ})
    mgr.cwd = "/moved"
    await mgr.flush()
    entries = await store.load()
    assert entries["default"]["cwd"] == "/moved"
    assert entries["agent"]["mount_modes"] == {"/s3": "read"}


@pytest.mark.asyncio
async def test_manager_close_deletes_from_store():
    store = RAMSessionStore()
    mgr = SessionManager("default", store=store)
    mgr.create("gone")
    await mgr.flush()
    await mgr.close("gone")
    assert "gone" not in await store.load()


@pytest.mark.asyncio
async def test_sessions_persist_across_workspaces_on_shared_store():
    store = RAMSessionStore()
    ram = RAMResource()
    ws_a = Workspace({"/data": ram}, mode=MountMode.EXEC, session_store=store)
    ws_a.create_session("narrow", mounts={"/data": "read"})
    await ws_a.flush_sessions()

    ws_b = Workspace({"/data": ram}, mode=MountMode.EXEC, session_store=store)
    result = await ws_b.execute("echo blocked > /data/x.txt",
                                session_id="narrow")
    assert result.exit_code != 0
