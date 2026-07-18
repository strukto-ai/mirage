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

from mirage import MountMode, Workspace
from mirage.observe.log_entry import EVENT_COMMAND
from mirage.resource.ram import RAMResource
from mirage.server.version.api import commit
from mirage.server.version.backend import LocalBackend
from mirage.server.version.state_diff import state_diff
from mirage.server.version.store import VersionStore


def _ws() -> Workspace:
    return Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                     mode=MountMode.EXEC)


@pytest.mark.asyncio
async def test_state_diff_covers_every_category(tmp_path):
    ws = _ws()
    store = await VersionStore.open(LocalBackend(str(tmp_path)), "ws")

    await ws.execute("echo one > /m/a.txt")
    session = ws.create_session("narrow", mounts={"/m": "read"})
    session.env["API_KEY"] = "@aws:prod-key"
    await ws.flush_sessions()
    v1 = await commit(store, ws, "main", "v1")

    await ws.execute("echo two > /m/a.txt")
    await ws.execute("ln -s /m/a.txt /m/l.txt")
    session.env["API_KEY"] = "@aws:other-key"
    session.mount_modes = {**session.mount_modes, "/m": MountMode.WRITE}
    await ws.flush_sessions()
    v2 = await commit(store, ws, "main", "v2")

    diff = await state_diff(store, v1, v2)

    assert diff["files"]["modified"] == ["m/a.txt"]
    changed = diff["sessions"]["modified"]["narrow"]
    assert changed["env"]["modified"]["API_KEY"] == {
        "from": "@aws:prod-key",
        "to": "@aws:other-key",
    }
    assert changed["mount_modes"]["modified"]["/m"] == {
        "from": "read",
        "to": "write",
    }
    assert "/m/l.txt" in diff["namespace"]["added"]
    commands = [
        e["command"] for e in diff["commands"]
        if e.get("type") == EVENT_COMMAND
    ]
    assert "echo two > /m/a.txt" in commands
    assert "echo one > /m/a.txt" not in commands


@pytest.mark.asyncio
async def test_state_diff_reports_grant_changes_with_direction(tmp_path):
    ws = _ws()
    store = await VersionStore.open(LocalBackend(str(tmp_path)), "ws")
    session = ws.create_session("narrow", mounts={"/m": "write"})
    await ws.flush_sessions()
    v1 = await commit(store, ws, "main", "v1")
    session.mount_modes = {**session.mount_modes, "/m": MountMode.READ}
    await ws.flush_sessions()
    v2 = await commit(store, ws, "main", "v2")

    forward = await state_diff(store, v1, v2)
    backward = await state_diff(store, v2, v1)

    forward_grants = forward["sessions"]["modified"]["narrow"]["mount_modes"]
    backward_grants = backward["sessions"]["modified"]["narrow"]["mount_modes"]
    assert forward_grants["modified"]["/m"] == {"from": "write", "to": "read"}
    assert backward_grants["modified"]["/m"] == {"from": "read", "to": "write"}


@pytest.mark.asyncio
async def test_state_diff_accepts_branch_refs(tmp_path):
    ws = _ws()
    store = await VersionStore.open(LocalBackend(str(tmp_path)), "ws")
    await ws.execute("echo one > /m/a.txt")
    v1 = await commit(store, ws, "main", "v1")
    await ws.execute("echo new > /m/b.txt")
    await commit(store, ws, "main", "v2")

    diff = await state_diff(store, v1, "main")

    assert diff["files"]["added"] == ["m/b.txt"]
