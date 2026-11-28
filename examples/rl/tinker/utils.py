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

import json
from typing import Annotated

from tinker_cookbook.renderers.base import Message, ToolCall
from tinker_cookbook.tool_use import ToolResult, simple_tool_result, tool

from mirage import Workspace
from mirage.workspace.tools.tool_descriptions import SHELL_DESCRIPTION


class MirageShellTool:
    """Tinker Tool wrapping the default Mirage Workspace shell.

    Commands execute directly through ``workspace.tools.shell`` so working
    directory, environment variables, and profile policies persist across
    turns and output stays plain terminal text.

    Args:
        workspace (Workspace): Rollout Mirage workspace under its default
            profile.
    """

    def __init__(self, workspace: Workspace) -> None:
        self._ws = workspace

    @tool
    async def shell(
        self,
        command: Annotated[str, "The command line to run."],
    ) -> ToolResult:
        result = await self._ws.tools.shell(command)
        return simple_tool_result(result.text or "(no output)")


MirageShellTool.shell._description = SHELL_DESCRIPTION


def shell_turn(call_id: str, command: str) -> Message:
    """Build an assistant Message invoking the Mirage ``shell`` tool.

    Args:
        call_id (str): Tool call identifier for the trajectory turn.
        command (str): Shell pipeline to run in the Mirage workspace.

    Returns:
        Message: Assistant message ready for ``AgentToolMessageEnv.step``.
    """
    return {
        "role": "assistant",
        "content": "",
        "tool_calls": [
            ToolCall(
                id=call_id,
                function=ToolCall.FunctionBody(
                    name="shell",
                    arguments=json.dumps({"command": command}),
                ),
            )
        ],
    }
