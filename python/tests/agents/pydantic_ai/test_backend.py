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
from pydantic_ai.workspaces import WorkspaceRef, WorkspaceUnavailableError
from pydantic_ai.workspaces.conformance import WorkspaceBackendSuite

from mirage import RAMVFS, MountMode, Workspace
from mirage.agents.pydantic_ai.backend import MirageWorkspaceBackend


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
