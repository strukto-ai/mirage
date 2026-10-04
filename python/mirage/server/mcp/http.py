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
from typing import Any

import anyio
from fastapi import FastAPI
from mcp.server import Server, ServerRequestContext
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import DEFAULT_MAX_REQUEST_BODY_SIZE
from mcp.shared.exceptions import MCPError
from mcp.types import (
    INVALID_REQUEST,
    CallToolRequestParams,
    CallToolResult,
    ListToolsResult,
    PaginatedRequestParams,
)
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.types import Message, Receive, Scope, Send

from mirage import __version__
from mirage.server.inflight import InFlight, rpc_messages
from mirage.server.io_serde import io_result_to_dict
from mirage.server.jobs import JobStatus, JobTable
from mirage.server.mcp.server import MirageMcpServer
from mirage.server.registry import WorkspaceEntry, WorkspaceRegistry
from mirage.types import JsonValue
from mirage.workspace.execution import ExecutionScope
from mirage.workspace.session.session import SessionState
from mirage.workspace.tools.io_text import io_to_str
from mirage.workspace.tools.tool_operations import (
    MirageToolOperations,
    ToolResult,
)
from mirage.workspace.workspace import Session

MCP_PATH = "/v1/workspaces/{workspace_id}/mcp"


class DaemonToolOperations(MirageToolOperations):
    """The tool table as the daemon serves it: through its own API.

    ``shell`` is a job, submitted to the daemon's job table the way
    ``POST /shell`` submits one, so an MCP command is listed by
    ``/v1/jobs``, can be cancelled there, and is recorded like any other.
    A caller cancelled while it waits (an MCP client's cancel) cancels
    the job too.
    The other tools run on the workspace's own loop through the
    session's own table (``session.tools``), so a read through any door
    guards a write through another.

    Args:
        entry (WorkspaceEntry): the workspace the tools act on.
        jobs (JobTable): the daemon's job table.
        session_id (str): the session the tools act as.
    """

    def __init__(
        self, entry: WorkspaceEntry, jobs: JobTable, session_id: str
    ) -> None:
        super().__init__(Session(entry.runner.ws, session_id))
        self._entry = entry
        self._jobs = jobs
        self._session_id = session_id

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
                command, session_id=self._session_id, execution_scope=scope
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
            session_id=self._session_id,
        )
        try:
            job = await self._jobs.wait(job.id)
        except asyncio.CancelledError:
            with anyio.CancelScope(shield=True):
                await self._jobs.cancel(job.id)
            raise
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

        async def on_loop() -> ToolResult:
            return await self._session.tools.call(name, arguments)

        return await self._entry.runner.call(on_loop())


class McpDoor:
    """Serves every workspace's tools over MCP's streamable HTTP.

    The endpoint is stateless: each request runs in the workspace's
    default session, or the one ``?session_id=`` names, as ``/shell``
    picks its session. One tool table per workspace and live session outlives
    the requests, so the read one request stamps guards the edit the next
    one makes. The SDK's session manager starts on the first request, so
    the app serves MCP with or without ASGI lifespan events.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        jobs (JobTable): the daemon's job table, which runs ``shell``.
    """

    def __init__(self, registry: WorkspaceRegistry, jobs: JobTable) -> None:
        self._registry = registry
        self._jobs = jobs
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
        self.inflight = InFlight()

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        """Serve one MCP request over streamable HTTP.

        The endpoint is stateless, so it has no stream for the server to
        push on: ``GET`` answers 405, as ``DELETE`` does, the same on
        both hosts.

        Args:
            scope (Scope): the ASGI scope.
            receive (Receive): the ASGI receive channel.
            send (Send): the ASGI send channel.
        """
        if scope["method"] == "GET":
            refused = JSONResponse(
                {
                    "jsonrpc": "2.0",
                    "error": {
                        "code": -32000,
                        "message": "Method not allowed.",
                    },
                    "id": None,
                },
                status_code=405,
            )
            await refused(scope, receive, send)
            return
        request = Request(scope, receive)
        workspace_id = request.path_params["workspace_id"]
        try:
            served = await self._served_for(
                workspace_id, request.query_params.get("session_id")
            )
        except LookupError as exc:
            response = JSONResponse({"detail": exc.args[0]}, status_code=404)
            await response(scope, receive, send)
            return
        await self._start()
        if scope["method"] != "POST":
            await self._manager.handle_request(scope, receive, send)
            return
        received = bytearray()
        async for chunk in request.stream():
            received += chunk
            if len(received) > DEFAULT_MAX_REQUEST_BODY_SIZE:
                response = JSONResponse(
                    {"detail": "request body too large"}, status_code=413
                )
                await response(scope, receive, send)
                return
        body = bytes(received)
        session_id = served[1].session_id
        calls = []
        for message in rpc_messages(body):
            params = message.get("params")
            if message.get("method") == "notifications/cancelled":
                if isinstance(params, dict):
                    self.inflight.cancel(
                        InFlight.key(
                            workspace_id, session_id, params.get("requestId")
                        )
                    )
            elif message.get("method") == "tools/call" and "id" in message:
                calls.append(
                    InFlight.key(workspace_id, session_id, message["id"])
                )
        await self._handle(scope, receive, send, body, calls)

    async def _handle(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
        body: bytes,
        calls: list[str],
    ) -> None:
        """Hand a POST to the SDK, cancellable while its calls run.

        The body is read already, so it is replayed to the SDK. A tool
        call is held in ``inflight`` until it settles, so a client's
        ``notifications/cancelled`` on another request reaches it, and
        a caller that drops the request cancels it too.

        Args:
            scope (Scope): the ASGI scope.
            receive (Receive): the ASGI receive, past the body.
            send (Send): the ASGI send.
            body (bytes): the request body.
            calls (list[str]): the in-flight keys of its tool calls.
        """
        replayed = False
        started = False
        finished = False

        async def replay() -> Message:
            nonlocal replayed
            if replayed:
                return await receive()
            replayed = True
            return {"type": "http.request", "body": body, "more_body": False}

        if not calls:
            await self._manager.handle_request(scope, replay, send)
            return

        async def tracked(message: Message) -> None:
            nonlocal started, finished
            if message["type"] == "http.response.start":
                started = True
            if message["type"] == "http.response.body" and not message.get(
                "more_body", False
            ):
                finished = True
            await send(message)

        held = asyncio.Event()

        async def hold() -> Message:
            nonlocal replayed
            if replayed:
                await held.wait()
                return {"type": "http.disconnect"}
            replayed = True
            return {"type": "http.request", "body": body, "more_body": False}

        task = asyncio.ensure_future(
            self._manager.handle_request(scope, hold, tracked)
        )

        async def caller_gone() -> None:
            while (await receive())["type"] != "http.disconnect":
                pass
            if not finished:
                task.cancel()

        for call in calls:
            self.inflight.add(call, task.cancel)
        watcher = asyncio.ensure_future(caller_gone())
        try:
            await task
        except asyncio.CancelledError:
            current = asyncio.current_task()
            if current is not None and current.cancelling():
                raise
            if finished:
                return
            if not started:
                await send({"type": "http.response.start", "status": 204})
            await send(
                {"type": "http.response.body", "body": b"", "more_body": False}
            )
        finally:
            held.set()
            watcher.cancel()
            for call in calls:
                self.inflight.discard(call, task.cancel)

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
        RPC endpoint and the CLI through them), so a read through one
        door stamps the file for an edit through another.

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
                MirageMcpServer(ws, operations=operations),
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
