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
from pydantic_ai import Agent
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.workspaces import WorkspaceRef
from pydantic_ai_backends import PERMISSIVE_RULESET, ConsoleCapability

from mirage import RAMVFS, MountMode, Workspace
from mirage.agents.pydantic_ai.capability import MirageWorkspace
from mirage.types import JsonValue


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def workspace():
    return Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)


def scripted(*calls: tuple[str, dict[str, JsonValue]]) -> FunctionModel:
    def respond(
        messages: list[ModelMessage], info: AgentInfo
    ) -> ModelResponse:
        step = sum(isinstance(m, ModelResponse) for m in messages)
        if step < len(calls):
            name, args = calls[step]
            return ModelResponse(parts=[ToolCallPart(name, args)])
        return ModelResponse(parts=[TextPart("done")])

    return FunctionModel(respond)


def test_declines_a_ref_naming_another_session(workspace):
    workspace.create_session("agent")
    capability = MirageWorkspace(workspace, session_id="agent")
    own = WorkspaceRef(provider="mirage", id="agent")
    other = WorkspaceRef(provider="mirage", id=workspace.default_session_id)
    foreign = WorkspaceRef(provider="local", id="agent")
    assert capability.get_workspace(None, ref=other) is None
    assert capability.get_workspace(None, ref=foreign) is None
    backend = capability.get_workspace(None, ref=own)
    assert backend is not None and backend.ref == own


def test_the_default_session_keeps_a_ref_for_first_use(workspace):
    capability = MirageWorkspace(workspace)
    ref = WorkspaceRef(provider="mirage", id="adopted-on-load")
    backend = capability.get_workspace(None, ref=ref)
    assert backend is not None and backend.ref == ref


@pytest.mark.anyio
async def test_console_tools_reach_the_mounts(workspace):
    agent = Agent(
        scripted(
            ("write_file", {"path": "notes/a.txt", "content": "hello\n"}),
            (
                "edit_file",
                {
                    "path": "/notes/a.txt",
                    "old_string": "hello",
                    "new_string": "hi there",
                },
            ),
            ("execute", {"command": "cat /notes/a.txt | tr a-z A-Z"}),
            ("grep", {"pattern": "there", "path": "/notes"}),
            ("glob", {"pattern": "**/*.txt", "path": "/"}),
        ),
        capabilities=[
            MirageWorkspace(workspace),
            ConsoleCapability(permissions=PERMISSIVE_RULESET),
        ],
    )
    result = await agent.run("work in the notes")
    returns = [
        str(part.content)
        for message in result.all_messages()
        for part in message.parts
        if isinstance(part, ToolReturnPart)
    ]
    assert await workspace.vfs.read("/notes/a.txt") == b"hi there\n"
    assert "HI THERE" in returns[2]
    assert "notes/a.txt" in returns[3]
    assert "notes/a.txt" in returns[4]
