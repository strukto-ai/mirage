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

import errno

import pytest
from pydantic_ai.workspaces import WorkspaceRef, WorkspaceUnavailableError
from pydantic_ai.workspaces.conformance import WorkspaceBackendSuite

from mirage import RAMVFS, MountMode, Workspace
from mirage.agents.pydantic_ai.backend import MirageWorkspaceBackend
from mirage.ops.ops import Ops


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def workspace():
    return Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)


class TestConformance(WorkspaceBackendSuite):
    @pytest.fixture
    def backend(self, workspace):
        return MirageWorkspaceBackend(workspace)

    @pytest.fixture
    def fresh_backend(self, workspace):
        return lambda: MirageWorkspaceBackend(workspace)

    @pytest.fixture
    def attach_backend(self, workspace):
        return lambda ref: MirageWorkspaceBackend(workspace, ref.id)

    @pytest.fixture
    def filesystem_honors_shell_permissions(self):
        return False


@pytest.mark.anyio
async def test_a_command_runs_in_a_clone_of_the_session(workspace):
    backend = MirageWorkspaceBackend(workspace)
    await backend.run("mkdir /sub && cd /sub && export X=1", shell=True)
    result = await backend.run('pwd; echo "x=$X"', shell=True)
    assert result.stdout == "/\nx=\n"
    assert await backend.working_dir() == "/"


@pytest.mark.anyio
async def test_a_refusal_is_appended_to_stderr():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.WRITE,
        route_policy=lambda ctx: (
            {"deny": "no lists"} if ctx.command == "ls" else None
        ),
    )
    result = await MirageWorkspaceBackend(ws).run(["ls", "/"])
    assert (result.exit_code, result.stderr) == (
        126,
        "ls: Permission denied\npolicy denied: no lists\n",
    )


@pytest.mark.anyio
async def test_files_act_as_the_session():
    ws = Workspace(
        {"/": RAMVFS(), "/vault": RAMVFS()},
        mode=MountMode.WRITE,
        profiles={"guarded": {"paths": {"hide": ["/vault"]}}},
    )
    await ws.shell("echo key > /vault/key.txt")
    ws.create_session("agent", profile="guarded")
    backend = MirageWorkspaceBackend(ws, "agent")
    assert backend.ref == WorkspaceRef(provider="mirage", id="agent")
    with pytest.raises(FileNotFoundError):
        await backend.read_bytes("/vault/key.txt")
    assert "vault" not in {e.name for e in await backend.list_dir("/")}


@pytest.mark.anyio
async def test_a_closed_session_is_unavailable(workspace):
    workspace.create_session("agent")
    backend = MirageWorkspaceBackend(workspace, "agent")
    await backend.working_dir()
    await workspace.close_session("agent")
    with pytest.raises(WorkspaceUnavailableError):
        await backend.working_dir()


@pytest.mark.anyio
async def test_remove_never_crosses_into_a_mount():
    ws = Workspace(
        {"/": RAMVFS(), "/data/inner/": RAMVFS()}, mode=MountMode.WRITE
    )
    await ws.shell(
        "mkdir -p /data; echo a > /data/a.txt; echo k > /data/inner/keep.txt"
    )
    backend = MirageWorkspaceBackend(ws)
    for path in ("/data", "/data/inner"):
        with pytest.raises(OSError) as raised:
            await backend.remove(path)
        assert raised.value.errno == errno.EBUSY
    assert await ws.vfs.read("/data/a.txt") == b"a\n"
    assert await ws.vfs.read("/data/inner/keep.txt") == b"k\n"


@pytest.mark.anyio
async def test_files_and_links_need_no_commands():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.WRITE,
        route_policy=lambda ctx: {"deny": "no commands"},
    )
    backend = MirageWorkspaceBackend(ws)
    await backend.make_dir("/real")
    await ws.vfs.symlink("/link", "/real")
    await backend.write_bytes("/link/f.txt", b"x")
    assert await backend.realpath("/link/f.txt") == "/real/f.txt"
    await backend.remove("/real/f.txt")
    assert not await backend.exists("/real/f.txt")


@pytest.mark.anyio
async def test_a_refused_child_stat_fails_the_listing(workspace, monkeypatch):
    backend = MirageWorkspaceBackend(workspace)
    await backend.write_bytes("/d/a.txt", b"a")
    real = Ops.stat

    async def refusing(self, path, **kwargs):
        if path == "/d/a.txt":
            raise PermissionError(errno.EACCES, "Permission denied", path)
        return await real(self, path, **kwargs)

    monkeypatch.setattr(Ops, "stat", refusing)
    with pytest.raises(PermissionError):
        await backend.list_dir("/d")


@pytest.mark.anyio
async def test_a_default_session_ref_is_checked_on_first_use(workspace):
    gone = WorkspaceRef(provider="mirage", id="not-the-default")
    with pytest.raises(WorkspaceUnavailableError):
        await MirageWorkspaceBackend(workspace, ref=gone).working_dir()
    own = WorkspaceRef(provider="mirage", id=workspace.default_session_id)
    backend = MirageWorkspaceBackend(workspace, ref=own)
    assert await backend.working_dir() == "/"
    assert backend.ref == own


@pytest.mark.anyio
async def test_paths_resolve_from_the_working_directory(workspace):
    workspace.create_session("agent")
    await workspace.shell("mkdir /work && cd /work", session_id="agent")
    backend = MirageWorkspaceBackend(workspace, "agent")
    assert await backend.realpath("notes.txt") == "/work/notes.txt"
    for path in ("/work/", "/work/.", "/"):
        with pytest.raises(ValueError):
            await backend.remove(path)
    assert await backend.exists("/work")


@pytest.mark.anyio
async def test_remove_sees_a_mount_through_a_link():
    ws = Workspace(
        {"/": RAMVFS(), "/data/inner/": RAMVFS()}, mode=MountMode.WRITE
    )
    await ws.shell("mkdir -p /data; echo k > /data/inner/keep.txt")
    await ws.vfs.symlink("/alias", "/data")
    with pytest.raises(OSError) as raised:
        await MirageWorkspaceBackend(ws).remove("/alias/inner")
    assert raised.value.errno == errno.EBUSY
    assert await ws.vfs.read("/data/inner/keep.txt") == b"k\n"


@pytest.mark.anyio
async def test_a_hidden_mount_is_absent_to_remove():
    ws = Workspace(
        {"/": RAMVFS(), "/vault": RAMVFS()},
        mode=MountMode.WRITE,
        profiles={"guarded": {"paths": {"hide": ["/vault"]}}},
    )
    ws.create_session("agent", profile="guarded")
    with pytest.raises(FileNotFoundError):
        await MirageWorkspaceBackend(ws, "agent").remove("/vault")


@pytest.mark.anyio
async def test_a_link_loop_is_eloop(workspace):
    await workspace.vfs.symlink("/a", "b")
    await workspace.vfs.symlink("/b", "a")
    with pytest.raises(OSError) as raised:
        await MirageWorkspaceBackend(workspace).realpath("/a/x")
    assert raised.value.errno == errno.ELOOP
