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
from collections.abc import Mapping
from functools import partial
from typing import Any

from fastapi import FastAPI
from mcp.server import Server, ServerRequestContext
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.shared.exceptions import MCPError
from mcp.types import (
    INVALID_REQUEST,
    CallToolRequestParams,
    CallToolResult,
    ListToolsResult,
    PaginatedRequestParams,
)
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.types import Receive, Scope, Send

from mirage import __version__
from mirage.agents.io_text import io_to_str
from mirage.agents.tool_operations import MirageToolOperations, ToolResult
from mirage.server.io_serde import io_result_to_dict
from mirage.server.jobs import JobStatus, JobTable
from mirage.server.mcp.server import MirageMcpServer
from mirage.server.registry import WorkspaceEntry, WorkspaceRegistry
from mirage.types import JsonValue
from mirage.workspace.execution import ExecutionScope
from mirage.workspace.session.session import SessionState

MCP_PATH = "/v1/workspaces/{workspace_id}/mcp"


class DaemonToolOperations(MirageToolOperations):
    """The tool table as the daemon serves it: through its own API.

    ``shell`` is a job, submitted to the daemon's job table the way
    ``POST /shell`` submits one, so an MCP command is listed by
    ``/v1/jobs``, can be cancelled there, and is recorded like any other.
    The other tools run on the workspace's own loop.

    Args:
        entry (WorkspaceEntry): the workspace the tools act on.
        jobs (JobTable): the daemon's job table.
        session_id (str): the session the tools act as.
    """

    def __init__(
        self, entry: WorkspaceEntry, jobs: JobTable, session_id: str
    ) -> None:
        super().__init__(entry.runner.ws, True, session_id)
        self._entry = entry
        self._jobs = jobs
        self._session = session_id

    async def shell(self, command: str) -> ToolResult:
        """Run a command line as a job of the daemon.

        Args:
            command (str): The command line to run.

        Returns:
            ToolResult: The command's rendered output, or the job's failure.
        """
        runner = self._entry.runner
        answers: list[ToolResult] = []

        async def run_line(scope: ExecutionScope) -> JsonValue:
            io = await runner.ws.shell(
                command, session_id=self._session, execution_scope=scope
            )
            payload = await io_result_to_dict(io)
            answers.append(ToolResult(io_to_str(io), io.exit_code != 0))
            return payload

        async def run(scope: ExecutionScope) -> JsonValue:
            return await runner.call(run_line(scope))

        job = await self._jobs.submit(
            workspace_id=self._entry.id,
            command=command,
            factory=run,
            session_id=self._session,
        )
        job = await self._jobs.wait(job.id)
        if job.status == JobStatus.CANCELED:
            return ToolResult("job canceled", True)
        if job.status == JobStatus.FAILED or not answers:
            return ToolResult(job.error or "shell failed", True)
        return answers[0]

    async def call(
        self, name: str, arguments: Mapping[str, Any]
    ) -> ToolResult:
        """Run one tool: ``shell`` as a job, the rest on the workspace's loop.

        Args:
            name (str): the tool's name.
            arguments (Mapping[str, Any]): the tool's input.

        Returns:
            ToolResult: the tool's answer.
        """
        if name == "shell":
            return await super().call(name, arguments)
        return await self._entry.runner.call(super().call(name, arguments))


class McpDoor:
    """Serves every workspace's tools over MCP's streamable HTTP.

    The endpoint is stateless: each request runs in the workspace's
    default session, or the one ``?session_id=`` names, as ``/shell``
    picks its session. One tool table per workspace and live session outlives
    the requests, so the read one request stamps guards the edit the next
    one makes. The SDK's session manager starts on the first request, so
    the app serves MCP with or without ASGI lifespan events. ``app``
    serves the same route with no auth in front, for a door that already
    admitted its caller: the SSH relay.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        jobs (JobTable): the daemon's job table, which runs ``shell``.
    """

    def __init__(self, registry: WorkspaceRegistry, jobs: JobTable) -> None:
        self._registry = registry
        self._jobs = jobs
        self.app = Starlette(
            routes=[Route(MCP_PATH, self, methods=["GET", "POST", "DELETE"])]
        )
        self._served: dict[
            tuple[str, str],
            tuple[
                WorkspaceEntry,
                SessionState,
                DaemonToolOperations,
                MirageMcpServer,
            ],
        ] = {}
        self.server: Server[dict[str, Any]] = Server(
            "mirage",
            version=__version__,
            on_list_tools=self.list_tools,
            on_call_tool=self.call_tool,
        )
        self._manager = StreamableHTTPSessionManager(
            app=self.server, stateless=True
        )
        self._ready = asyncio.Event()
        self._stop = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        try:
            await self._target(Request(scope, receive))
        except LookupError as exc:
            response = JSONResponse({"detail": exc.args[0]}, status_code=404)
            await response(scope, receive, send)
            return
        await self._start()
        await self._manager.handle_request(scope, receive, send)

    async def _start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._serve())
        await self._ready.wait()

    async def _serve(self) -> None:
        try:
            async with self._manager.run():
                self._ready.set()
                await self._stop.wait()
        finally:
            self._ready.set()

    async def close(self) -> None:
        """Stop the session manager, if a request started it."""
        if self._task is None:
            return
        self._stop.set()
        await self._task

    async def tools(
        self, workspace_id: str, session_id: str | None = None
    ) -> DaemonToolOperations:
        """The tool table a workspace session is served by.

        One table per workspace and live session, shared by every door
        that serves the tools (this endpoint, the HTTP tool routes, the
        CLI and SSH through them), so a read through one door stamps
        the file for an edit through another.

        Args:
            workspace_id (str): the workspace.
            session_id (str | None): the session; None is the
                workspace's default.

        Returns:
            DaemonToolOperations: the table.

        Raises:
            LookupError: the workspace or the session does not exist.
        """
        return (await self._served_for(workspace_id, session_id))[2]

    async def _served_for(
        self, workspace_id: str, session_id: str | None
    ) -> tuple[
        WorkspaceEntry, SessionState, DaemonToolOperations, MirageMcpServer
    ]:
        for key, (entry, held, _, _) in list(self._served.items()):
            if (
                key[0] not in self._registry
                or self._registry.get(key[0]) is not entry
                or all(s is not held for s in entry.runner.ws.list_sessions())
            ):
                del self._served[key]
        if workspace_id not in self._registry:
            raise LookupError("workspace not found")
        entry = self._registry.get(workspace_id)
        ws = entry.runner.ws
        await entry.runner.call(ws.ensure_sessions_loaded())
        session_id = session_id or ws.default_session_id
        key = (workspace_id, session_id)
        session = next(
            (s for s in ws.list_sessions() if s.session_id == session_id), None
        )
        if session is None:
            self._served.pop(key, None)
            raise LookupError("session not found")
        served = self._served.get(key)
        if served is None or served[1] is not session:
            operations = DaemonToolOperations(entry, self._jobs, session_id)
            served = (
                entry,
                session,
                operations,
                MirageMcpServer(
                    ws,
                    operations=operations,
                    operations_for=partial(self.tools, workspace_id),
                ),
            )
            self._served[key] = served
        return served

    async def _target(self, request: Request) -> MirageMcpServer:
        """The MCP server a request is for.

        Args:
            request (Request): the HTTP request.

        Returns:
            MirageMcpServer: the server for its workspace and session.

        Raises:
            LookupError: the workspace or the session does not exist.
        """
        served = await self._served_for(
            request.path_params["workspace_id"],
            request.query_params.get("session_id"),
        )
        return served[3]

    async def _context_target(
        self, ctx: ServerRequestContext[dict[str, Any]]
    ) -> MirageMcpServer:
        if not isinstance(ctx.request, Request):
            raise MCPError(INVALID_REQUEST, "not an HTTP request")
        try:
            return await self._target(ctx.request)
        except LookupError as exc:
            raise MCPError(INVALID_REQUEST, exc.args[0]) from exc

    async def list_tools(
        self,
        ctx: ServerRequestContext[dict[str, Any]],
        params: PaginatedRequestParams | None,
    ) -> ListToolsResult:
        """Report the tool table of the request's workspace.

        Args:
            ctx (ServerRequestContext[dict[str, Any]]): the request
                context, carrying the HTTP request.
            params (PaginatedRequestParams | None): the page cursor.

        Returns:
            ListToolsResult: every tool the workspace serves.
        """
        target = await self._context_target(ctx)
        return await target.list_tools(ctx, params)

    async def call_tool(
        self,
        ctx: ServerRequestContext[dict[str, Any]],
        params: CallToolRequestParams,
    ) -> CallToolResult:
        """Run one tool call in the request's workspace and session.

        Args:
            ctx (ServerRequestContext[dict[str, Any]]): the request
                context, carrying the HTTP request.
            params (CallToolRequestParams): the tool name and arguments.

        Returns:
            CallToolResult: the tool's answer.
        """
        target = await self._context_target(ctx)
        return await target.call_tool(ctx, params)


def register_mcp_routes(
    app: FastAPI, registry: WorkspaceRegistry, jobs: JobTable
) -> McpDoor:
    """Serve MCP at ``/v1/workspaces/{workspace_id}/mcp``.

    The route sits behind the app's host check and auth, as every other
    route does.

    Args:
        app (FastAPI): the daemon app.
        registry (WorkspaceRegistry): the daemon's workspaces.
        jobs (JobTable): the daemon's job table.

    Returns:
        McpDoor: the door, whose ``close`` the app's lifespan awaits.
    """
    door = McpDoor(registry, jobs)
    app.router.routes.append(
        Route(
            MCP_PATH,
            door,
            methods=["GET", "POST", "DELETE"],
            include_in_schema=False,
        )
    )
    return door
