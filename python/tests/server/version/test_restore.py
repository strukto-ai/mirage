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
from mirage.policy import Action, Deny, Policy, PolicyDenied
from mirage.policy.types import SessionContext
from mirage.resource.ram import RAMResource
from mirage.server.version.api import commit
from mirage.server.version.backend import LocalBackend
from mirage.server.version.restore import restore
from mirage.server.version.store import VersionStore
from mirage.workspace.session.state import seed_var


async def _cat(ws: Workspace, path: str) -> str:
    result = await ws.execute(f"cat {path}")
    return result.stdout.decode()


def _ws() -> Workspace:
    return Workspace({"/m": (RAMResource(), MountMode.WRITE)},
                     mode=MountMode.EXEC)


async def _two_file_history(ws, store):
    await ws.execute("echo one > /m/a.txt")
    await ws.execute("echo keep > /m/b.txt")
    v1 = await commit(store, ws, "main", "v1")
    await ws.execute("echo two > /m/a.txt")
    await ws.execute("echo edited > /m/b.txt")
    return v1


# A checkout used to re-apply a version's grants like any other state,
# so a session the host had narrowed since the commit woke wider than the
# host left it. A restored table now lands under the live session and
# never wider than it: the version's restrictions join the live ones,
# and `set_session_profile` is the host's reset.
@pytest.mark.asyncio
async def test_restore_whole_world_never_widens_a_live_session(tmp_path):
    ws = _ws()
    store = await VersionStore.open(LocalBackend(str(tmp_path)), "ws")
    ws.create_session("narrow", mounts={"/m": "write"})
    await ws.execute("echo one > /m/a.txt")
    await ws.flush_sessions()
    v1 = await commit(store, ws, "main", "v1")
    await ws.set_session_profile("narrow", {"mounts": {"/m": "read"}})
    await ws.execute("echo two > /m/a.txt")
    await ws.flush_sessions()

    report = await restore(store, ws, v1)

    assert await _cat(ws, "/m/a.txt") == "one\n"
    assert ws.get_session("narrow").mount_modes["/m"] == MountMode.READ
    assert report["categories"] == [
        "files", "history", "namespace", "sessions"
    ]
    refused = await ws.execute("echo three > /m/a.txt", session_id="narrow")
    assert refused.exit_code != 0
    await ws.set_session_profile("narrow", {"mounts": {"/m": "write"}})
    assert (await ws.execute("echo three > /m/a.txt",
                             session_id="narrow")).exit_code == 0
    assert await _cat(ws, "/m/a.txt") == "three\n"


# The version's own narrowing does land: a session narrower at the commit
# than it is live comes back narrower.
@pytest.mark.asyncio
async def test_restore_whole_world_lands_a_versions_restrictions(tmp_path):
    ws = _ws()
    store = await VersionStore.open(LocalBackend(str(tmp_path)), "ws")
    ws.create_session("narrow", mounts={"/m": "read"})
    await ws.flush_sessions()
    v1 = await commit(store, ws, "main", "v1")
    await ws.set_session_profile("narrow", {"mounts": {"/m": "write"}})
    assert (await ws.execute("echo two > /m/a.txt",
                             session_id="narrow")).exit_code == 0
    await ws.flush_sessions()

    await restore(store, ws, v1)

    assert ws.get_session("narrow").mount_modes["/m"] == MountMode.READ
    assert (await ws.execute("echo three > /m/a.txt",
                             session_id="narrow")).exit_code != 0


@pytest.mark.asyncio
async def test_restore_single_path_leaves_other_files_alone(tmp_path):
    ws = _ws()
    store = await VersionStore.open(LocalBackend(str(tmp_path)), "ws")
    v1 = await _two_file_history(ws, store)

    report = await restore(store, ws, v1, paths=["/m/a.txt"])

    assert await _cat(ws, "/m/a.txt") == "one\n"
    assert await _cat(ws, "/m/b.txt") == "edited\n"
    assert report["categories"] == ["files"]
    assert report["paths"] == ["/m/a.txt"]


@pytest.mark.asyncio
async def test_restore_files_category_keeps_live_sessions(tmp_path):
    ws = _ws()
    store = await VersionStore.open(LocalBackend(str(tmp_path)), "ws")
    session = ws.create_session("narrow", mounts={"/m": "read"})
    seed_var(session, "API_KEY", "@aws:prod-key")
    await ws.execute("echo one > /m/a.txt")
    await ws.flush_sessions()
    v1 = await commit(store, ws, "main", "v1")
    await ws.execute("echo two > /m/a.txt")
    seed_var(session, "API_KEY", "@aws:new-key")
    await ws.flush_sessions()

    report = await restore(store, ws, v1, categories=["files"])

    assert await _cat(ws, "/m/a.txt") == "one\n"
    assert ws.get_session("narrow").env["API_KEY"] == "@aws:new-key"
    assert report["categories"] == ["files"]


@pytest.mark.asyncio
async def test_restore_sessions_category_keeps_live_files(tmp_path):
    ws = _ws()
    store = await VersionStore.open(LocalBackend(str(tmp_path)), "ws")
    session = ws.create_session("narrow", mounts={"/m": "read"})
    seed_var(session, "API_KEY", "@aws:prod-key")
    await ws.execute("echo one > /m/a.txt")
    await ws.flush_sessions()
    v1 = await commit(store, ws, "main", "v1")
    await ws.execute("echo two > /m/a.txt")
    seed_var(session, "API_KEY", "@aws:new-key")
    await ws.flush_sessions()

    await restore(store, ws, v1, categories=["sessions"])

    assert await _cat(ws, "/m/a.txt") == "two\n"
    assert ws.get_session("narrow").env["API_KEY"] == "@aws:prod-key"


@pytest.mark.asyncio
async def test_restore_rejects_bad_scopes(tmp_path):
    ws = _ws()
    store = await VersionStore.open(LocalBackend(str(tmp_path)), "ws")
    await ws.execute("echo one > /m/a.txt")
    v1 = await commit(store, ws, "main", "v1")
    with pytest.raises(ValueError):
        await restore(store, ws, v1, paths=["/m/a.txt"], categories=["files"])
    with pytest.raises(ValueError):
        await restore(store, ws, v1, categories=["cache"])


class DenyGate(Policy):
    """Refuse env writes to GATE_* names, the deployment's rule."""

    async def pre_session(self, ctx: SessionContext) -> Action | None:
        if ctx.plane == "env" and ctx.key.startswith("GATE_"):
            return Deny("GATE_* refused by policy\n")
        return None


# The live cache was cleared ahead of the restore's gate, so a refused
# restore still sent every cached read back to its origin while the rest
# of the workspace stayed as it was; the clear now sits behind it.
@pytest.mark.asyncio
async def test_a_refused_restore_leaves_the_live_cache_alone(tmp_path):
    ws = _ws()
    store = await VersionStore.open(LocalBackend(str(tmp_path)), "ws")
    try:
        seed_var(ws.create_session("s2"), "GATE_X", "1")
        v1 = await commit(store, ws, "main", "v1")
        await ws.cache.set("k", b"cached")
        ws.policies.add(DenyGate())
        with pytest.raises(PolicyDenied):
            await restore(store, ws, v1)
        assert await ws.cache.get("k") == b"cached"
    finally:
        await ws.close()
