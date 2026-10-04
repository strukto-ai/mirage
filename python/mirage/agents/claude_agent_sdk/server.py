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
from mirage.workspace.tools.tool_operations import (
    MirageToolOperations,
    ToolResult,
)
from mirage.workspace.workspace import Session, Workspace


def _to_sdk(result: ToolResult) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "content": [{"type": "text", "text": result.text}]
    }
    if result.is_error:
        payload["is_error"] = True
    return payload


class _MirageTools:
    """Unpacks the SDK's argument dicts onto the shared operations.

    Args:
        workspace (Workspace): The workspace to serve.
        stale_write_protection (bool): False lets an agent overwrite a
            file that changed since it read it.
        session_id (str | None): The session the tools act as; None is
            the workspace's default session.
    """

    def __init__(
        self,
        workspace: Workspace,
        stale_write_protection: bool = True,
        session_id: str | None = None,
    ) -> None:
        session = Session(workspace, session_id)
        self._ops = (
            session.tools
            if stale_write_protection
            else MirageToolOperations(session, stale_write_protection=False)
        )

    async def shell(self, args: dict[str, Any]) -> dict[str, Any]:
        return _to_sdk(await self._ops.call("shell", args))

    async def read(self, args: dict[str, Any]) -> dict[str, Any]:
        return _to_sdk(await self._ops.call("read", args))

    async def write(self, args: dict[str, Any]) -> dict[str, Any]:
        return _to_sdk(await self._ops.call("write", args))

    async def edit(self, args: dict[str, Any]) -> dict[str, Any]:
        return _to_sdk(await self._ops.call("edit", args))

    async def ls(self, args: dict[str, Any]) -> dict[str, Any]:
        return _to_sdk(await self._ops.call("ls", args))

    async def grep(self, args: dict[str, Any]) -> dict[str, Any]:
        return _to_sdk(await self._ops.call("grep", args))

    async def glob(self, args: dict[str, Any]) -> dict[str, Any]:
        return _to_sdk(await self._ops.call("glob", args))


def MirageServer(
    workspace: Workspace,
    stale_write_protection: bool = True,
    session_id: str | None = None,
) -> Any:
    """Create an in-process Mirage server for the Claude Agent SDK.

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
    tools_impl = _MirageTools(workspace, stale_write_protection, session_id)
    return create_sdk_mcp_server(
        name="mirage",
        version=__version__,
        tools=[
            tool("shell", SHELL_DESCRIPTION, SHELL_INPUT)(tools_impl.shell),
            tool(
                "read",
                READ_DESCRIPTION,
                READ_INPUT,
                annotations=ToolAnnotations(readOnlyHint=True),
            )(tools_impl.read),
            tool("write", WRITE_DESCRIPTION, WRITE_INPUT)(tools_impl.write),
            tool("edit", EDIT_DESCRIPTION, EDIT_INPUT)(tools_impl.edit),
            tool(
                "ls",
                LS_DESCRIPTION,
                LS_INPUT,
                annotations=ToolAnnotations(readOnlyHint=True),
            )(tools_impl.ls),
            tool(
                "grep",
                GREP_DESCRIPTION,
                GREP_INPUT,
                annotations=ToolAnnotations(readOnlyHint=True),
            )(tools_impl.grep),
            tool(
                "glob",
                GLOB_DESCRIPTION,
                GLOB_INPUT,
                annotations=ToolAnnotations(readOnlyHint=True),
            )(tools_impl.glob),
        ],
    )
