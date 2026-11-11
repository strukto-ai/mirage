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

from functools import partial
from typing import Any

try:
    from claude_agent_sdk import ToolAnnotations, create_sdk_mcp_server, tool
except ImportError as exc:
    raise ImportError(
        "`claude-agent-sdk` not installed. "
        "Install with: pip install 'mirage-ai[claude-agent-sdk]'"
    ) from exc

from mirage import __version__
from mirage.workspace.tools.tool_descriptions import (
    EDIT_DESCRIPTION,
    EDIT_INPUT,
    GLOB_DESCRIPTION,
    GLOB_INPUT,
    GREP_DESCRIPTION,
    GREP_INPUT,
    LS_DESCRIPTION,
    LS_INPUT,
    READ_DESCRIPTION,
    READ_INPUT,
    SHELL_DESCRIPTION,
    SHELL_INPUT,
    WRITE_DESCRIPTION,
    WRITE_INPUT,
)
from mirage.workspace.tools.tool_operations import MirageToolOperations
from mirage.workspace.workspace import Session, Workspace


def MirageServer(
    workspace: Workspace,
    stale_write_protection: bool = True,
    session_id: str | None = None,
) -> Any:
    """Create an in-process Mirage server for the Claude Agent SDK, with
    the tools the session's profile leaves it.

    Args:
        workspace (Workspace): The workspace to serve.
        stale_write_protection (bool): False lets an agent overwrite a
            file that changed since it read it.
        session_id (str | None): The session the tools act as, with its
            profile; None is the workspace's default session.

    Returns:
        Any: An SDK server object to pass to
            ClaudeAgentOptions(mcp_servers=...).
    """
    session = Session(workspace, session_id)
    ops = (
        session.tools
        if stale_write_protection
        else MirageToolOperations(session, stale_write_protection=False)
    )

    async def call(name: str, args: dict[str, Any]) -> dict[str, Any]:
        result = await ops.call(name, args)
        payload: dict[str, Any] = {
            "content": [{"type": "text", "text": result.text}]
        }
        if result.is_error:
            payload["is_error"] = True
        return payload

    read_only = ToolAnnotations(read_only_hint=True)
    names = ops.names()
    return create_sdk_mcp_server(
        name="mirage",
        version=__version__,
        tools=[
            tool(name, description, schema, annotations=hint)(
                partial(call, name)
            )
            for name, description, schema, hint in (
                ("shell", SHELL_DESCRIPTION, SHELL_INPUT, None),
                ("read", READ_DESCRIPTION, READ_INPUT, read_only),
                ("write", WRITE_DESCRIPTION, WRITE_INPUT, None),
                ("edit", EDIT_DESCRIPTION, EDIT_INPUT, None),
                ("ls", LS_DESCRIPTION, LS_INPUT, read_only),
                ("grep", GREP_DESCRIPTION, GREP_INPUT, read_only),
                ("glob", GLOB_DESCRIPTION, GLOB_INPUT, read_only),
            )
            if name in names
        ],
    )
