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
import logging
from collections.abc import Coroutine, Mapping
from typing import Any, TypeVar

import jsonschema
from mcp.server import Server, ServerRequestContext
from mcp.shared.exceptions import MCPError
from mcp.types import (
    INVALID_PARAMS,
    CallToolRequestParams,
    CallToolResult,
    ListToolsResult,
    PaginatedRequestParams,
    TextContent,
    Tool,
    ToolAnnotations,
)

from mirage import __version__
from mirage.server.io_serde import (
    answered,
    checked,
    explanation_to_dict,
    failure_to_dict,
)
from mirage.server.vfs_calls import VFS_CALLS, VfsCall, schema_of
from mirage.types import JsonValue
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

logger = logging.getLogger(__name__)

T = TypeVar("T")

READ_ONLY = ToolAnnotations(read_only_hint=True)

TOOLS = [
    Tool(
        name="shell",
        description=SHELL_DESCRIPTION,
        input_schema=SHELL_INPUT,
    ),
    Tool(
        name="read",
        description=READ_DESCRIPTION,
        annotations=READ_ONLY,
        input_schema=READ_INPUT,
    ),
    Tool(
        name="write",
        description=WRITE_DESCRIPTION,
        input_schema=WRITE_INPUT,
    ),
    Tool(
        name="edit",
        description=EDIT_DESCRIPTION,
        input_schema=EDIT_INPUT,
    ),
    Tool(
        name="ls",
        description=LS_DESCRIPTION,
        annotations=READ_ONLY,
        input_schema=LS_INPUT,
    ),
    Tool(
        name="grep",
        description=GREP_DESCRIPTION,
        annotations=READ_ONLY,
        input_schema=GREP_INPUT,
    ),
    Tool(
        name="glob",
        description=GLOB_DESCRIPTION,
        annotations=READ_ONLY,
        input_schema=GLOB_INPUT,
    ),
]


EXPLAIN: dict[str, JsonValue] = {
    "type": "boolean",
    "description": "Answer what the call would do instead of doing it.",
}


def _explainable(schema: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
    properties = schema["properties"]
    if not isinstance(properties, dict):
        raise TypeError("an input schema lists its properties")
    return {**schema, "properties": {**properties, "explain": EXPLAIN}}


EXPLAINED_SHELL = Tool(
    name="shell",
    description=SHELL_DESCRIPTION,
    input_schema=_explainable(SHELL_INPUT),
)

VFS_TOOLS: dict[str, tuple[Tool, VfsCall]] = {
    f"vfs_{call.name}": (
        Tool(
            name=f"vfs_{call.name}",
            description=call.description,
            input_schema=_explainable(schema_of(call)),
        ),
        call,
    )
    for call in VFS_CALLS
}


def _to_mcp(result: ToolResult) -> CallToolResult:
    return CallToolResult(
        content=[TextContent(type="text", text=result.text)],
        is_error=result.is_error,
    )


def _json(value: JsonValue, is_error: bool = False) -> CallToolResult:
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return _to_mcp(ToolResult(text, is_error))


class MirageMcpServer:
    """Serves one workspace's tools over the MCP protocol.

    The handlers are bound methods handed to the SDK's constructor, so
    the tool table stays readable and nothing nests. The server runs
    with no lifespan, so its context is the default one's empty dict.
    With ``all_calls`` it also serves each ``session.vfs`` call as a
    ``vfs_<call>`` tool, and ``shell`` and every ``vfs_<call>`` take
    ``explain``, as the HTTP routes do.

    Args:
        workspace (Workspace): The workspace to serve.
        stale_write_protection (bool): False lets an agent overwrite a
            file that changed since it read it.
        name (str): Server name advertised to the client.
        version (str): Server version advertised to the client.
        session_id (str | None): The session the tools act as; None is
            the workspace's default session.
        operations (MirageToolOperations | None): The tool table to
            serve; the session's own (``session.tools``) when None. The
            daemon passes one that runs each call through its API.
        all_calls (bool): Also serve the VFS calls and explain.
    """

    def __init__(
        self,
        workspace: Workspace,
        stale_write_protection: bool = True,
        name: str = "mirage",
        version: str = __version__,
        session_id: str | None = None,
        operations: MirageToolOperations | None = None,
        all_calls: bool = False,
    ) -> None:
        session = Session(workspace, session_id)
        self._session = session
        self._all_calls = all_calls
        if operations is not None:
            self._ops = operations
        elif stale_write_protection:
            self._ops = session.tools
        else:
            self._ops = MirageToolOperations(
                session, stale_write_protection=False
            )
        self.server: Server[dict[str, Any]] = Server(
            name,
            version=version,
            on_list_tools=self.list_tools,
            on_call_tool=self.call_tool,
        )

    async def hop(self, work: Coroutine[Any, Any, T]) -> T:
        """Run a Session call where the workspace lives.

        Args:
            work (Coroutine[Any, Any, T]): the call.

        Returns:
            T: its result.
        """
        return await work

    async def _tools(self) -> list[Tool]:
        names = await self._ops.offered()
        tools = [t for t in TOOLS if t.name in names]
        if not self._all_calls:
            return tools
        return [EXPLAINED_SHELL if t.name == "shell" else t for t in tools] + [
            tool for tool, _ in VFS_TOOLS.values()
        ]

    async def list_tools(
        self,
        ctx: ServerRequestContext[dict[str, Any]],
        params: PaginatedRequestParams | None,
    ) -> ListToolsResult:
        """Report the tool table.

        Args:
            ctx (ServerRequestContext[dict[str, Any]]): The request
                context; unused.
            params (PaginatedRequestParams | None): The page cursor;
                every tool fits on one page.

        Returns:
            ListToolsResult: The tools the session's profile leaves it,
                then the VFS calls when this server serves them.
        """
        return ListToolsResult(tools=await self._tools())

    async def call_tool(
        self,
        ctx: ServerRequestContext[dict[str, Any]],
        params: CallToolRequestParams,
    ) -> CallToolResult:
        """Run one tool call.

        A tool this server does not serve, or one the session's profile
        does not leave it, is a protocol error, as the TypeScript twin
        answers it. Arguments outside the tool's input
        schema and a raised exception are the tool's answer, with
        `is_error` set, so the agent reads them and can retry. A VFS
        call and an explanation answer JSON, as the HTTP routes do; a
        failed VFS call answers the HTTP route's error body.

        Args:
            ctx (ServerRequestContext[dict[str, Any]]): The request
                context; unused.
            params (CallToolRequestParams): The tool name and arguments.

        Returns:
            CallToolResult: The tool's answer.

        Raises:
            MCPError: The tool name is not one this server serves.
        """
        tool = next(
            (t for t in await self._tools() if t.name == params.name), None
        )
        if tool is None:
            raise MCPError(INVALID_PARAMS, f"Tool {params.name} not found")
        arguments = params.arguments or {}
        try:
            jsonschema.validate(arguments, tool.input_schema)
        except jsonschema.ValidationError as exc:
            return _to_mcp(
                ToolResult(
                    "Input validation error: Invalid arguments for tool "
                    f"{params.name}: {exc.message}",
                    True,
                )
            )
        explain = arguments.get("explain", False)
        given = {k: v for k, v in arguments.items() if k != "explain"}
        try:
            if params.name in VFS_TOOLS:
                call = VFS_TOOLS[params.name][1]
                return _json(
                    await self.hop(
                        answered(
                            self._session, call, checked(call, given), explain
                        )
                    )
                )
            if tool is EXPLAINED_SHELL and explain:
                said = await self.hop(
                    self._session.explain.shell(given["command"])
                )
                return _json(explanation_to_dict(said))
            return _to_mcp(await self._ops.call(params.name, given))
        except Exception as exc:
            logger.debug("mcp tool %s failed", params.name, exc_info=True)
            if params.name in VFS_TOOLS:
                return _json(failure_to_dict(exc), True)
            return _to_mcp(ToolResult(str(exc), True))
