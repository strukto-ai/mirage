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
from typing import Any

try:
    from anthropic.lib.tools import (
        BetaAsyncFunctionTool,
        ToolError,
        beta_async_tool,
    )
    from anthropic.types.beta import (
        BetaManagedAgentsAgentToolset20260401BashInput,
        BetaManagedAgentsAgentToolset20260401EditInput,
        BetaManagedAgentsAgentToolset20260401GlobInput,
        BetaManagedAgentsAgentToolset20260401GrepInput,
        BetaManagedAgentsAgentToolset20260401ReadInput,
        BetaManagedAgentsAgentToolset20260401WriteInput,
    )
except ImportError as exc:
    raise ImportError(
        "`anthropic` not installed. "
        "Install with: pip install 'mirage-ai[claude-managed-agents]'"
    ) from exc

from mirage.types import JsonValue
from mirage.workspace.tools.tool_operations import (
    MirageToolOperations,
    ToolResult,
)
from mirage.workspace.workspace import Session, Workspace


def _answer(result: ToolResult) -> str:
    if result.is_error:
        raise ToolError(result.text)
    return result.text


def mirage_tools(
    workspace: Workspace,
    session_id: str | None = None,
    stale_write_protection: bool = True,
) -> list[BetaAsyncFunctionTool[Any]]:
    """The agent toolset's file and shell tools, run in a Mirage session.

    For a self-hosted environment's ``EnvironmentWorker(tools=...)``:
    ``bash``, ``read``, ``write``, ``edit``, ``glob`` and ``grep`` answer
    the agent's calls through the session's own tools, so its profile,
    mounts and policies apply. A tool every call of which the profile
    would refuse is left out. A relative path resolves against the
    session's working directory, as ``bash`` sees it.

    Args:
        workspace (Workspace): The workspace to serve.
        session_id (str | None): The session the tools act as, with its
            profile; None is the workspace's default session.
        stale_write_protection (bool): False lets an agent overwrite a
            file that changed since it read it.

    Returns:
        list[BetaAsyncFunctionTool[Any]]: The tools, by the toolset's
        names.
    """
    session = Session(workspace, session_id)
    ops = (
        session.tools
        if stale_write_protection
        else MirageToolOperations(session, stale_write_protection=False)
    )

    @beta_async_tool(
        name="bash",
        input_schema=BetaManagedAgentsAgentToolset20260401BashInput,
    )
    async def bash(
        command: str | None = None,
        restart: bool | None = None,
        timeout_ms: int | None = None,
    ) -> str:
        if restart:
            raise ToolError(
                "bash: restart is not supported; the Mirage session keeps "
                "its working directory and variables"
            )
        if not command:
            raise ToolError("bash: command is required")
        timeout = timeout_ms / 1000 if timeout_ms else None
        try:
            result = await asyncio.wait_for(
                ops.call("shell", {"command": command}), timeout
            )
        except TimeoutError as exc:
            raise ToolError(f"bash: timed out after {timeout_ms} ms") from exc
        return _answer(result)

    @beta_async_tool(
        name="read",
        input_schema=BetaManagedAgentsAgentToolset20260401ReadInput,
    )
    async def read(file_path: str, view_range: list[int] | None = None) -> str:
        args: dict[str, JsonValue] = {"path": file_path}
        if view_range:
            if len(view_range) != 2:
                raise ToolError(
                    "read: view_range must be [start_line, end_line]"
                )
            start = max(0, view_range[0] - 1)
            args["offset"] = start
            if view_range[1] > 0:
                args["limit"] = max(1, view_range[1] - start)
        return _answer(await ops.call("read", args))

    @beta_async_tool(
        name="write",
        input_schema=BetaManagedAgentsAgentToolset20260401WriteInput,
    )
    async def write(file_path: str, content: str) -> str:
        return _answer(
            await ops.call("write", {"path": file_path, "content": content})
        )

    @beta_async_tool(
        name="edit",
        input_schema=BetaManagedAgentsAgentToolset20260401EditInput,
    )
    async def edit(
        file_path: str,
        old_string: str,
        new_string: str,
        replace_all: bool | None = None,
    ) -> str:
        return _answer(
            await ops.call(
                "edit",
                {
                    "path": file_path,
                    "old_string": old_string,
                    "new_string": new_string,
                    "replace_all": bool(replace_all),
                },
            )
        )

    @beta_async_tool(
        name="glob",
        input_schema=BetaManagedAgentsAgentToolset20260401GlobInput,
    )
    async def glob(pattern: str, path: str | None = None) -> str:
        return _answer(
            await ops.call("glob", {"pattern": pattern, "path": path or "."})
        )

    @beta_async_tool(
        name="grep",
        input_schema=BetaManagedAgentsAgentToolset20260401GrepInput,
    )
    async def grep(pattern: str, path: str | None = None) -> str:
        return _answer(
            await ops.call("grep", {"pattern": pattern, "path": path or "."})
        )

    names = ops.names()
    return [
        tool
        for name, tool in (
            ("shell", bash),
            ("read", read),
            ("write", write),
            ("edit", edit),
            ("glob", glob),
            ("grep", grep),
        )
        if name in names
    ]
