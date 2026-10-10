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
import json
from collections.abc import Coroutine
from typing import Any, TypeVar

from fastapi import FastAPI
from mcp.server.transport_security import DEFAULT_MAX_REQUEST_BODY_SIZE
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from mirage.execution.types import ExecutionStatus
from mirage.server.inflight import InFlight
from mirage.server.io_serde import io_result_to_dict
from mirage.server.jobs import ExecutionTable
from mirage.server.mcp.http import McpEndpoint
from mirage.server.registry import WorkspaceEntry, WorkspaceRegistry
from mirage.server.rpc.constants import (
    RPC_INTERNAL_ERROR,
    RPC_INVALID_REQUEST,
    RPC_PARSE_ERROR,
)
from mirage.server.rpc.server import (
    CANCEL_REQUEST,
    RPC_REQUEST_CANCELLED,
    Message,
    MirageRpcServer,
    RpcError,
    error_response,
)
from mirage.server.rpc.server import Response as RpcResponse
from mirage.types import JsonValue
from mirage.workspace.execution import ExecutionScope
from mirage.workspace.tools.tool_operations import MirageToolOperations

RPC_PATH = "/v1/workspaces/{workspace_id}/rpc"

T = TypeVar("T")


class DaemonRpcServer(MirageRpcServer):
    """The RPC server as the daemon serves it.

    ``shell`` is a daemon job, as ``POST /shell`` and MCP's ``shell``
    are, so it is listed by ``/v1/jobs`` and a cancelled request cancels
    it. Every other call runs on the workspace's own loop.

    Args:
        entry (WorkspaceEntry): the workspace.
        jobs (ExecutionTable): the daemon's execution table.
        session_id (str): the session the methods act as.
        operations (MirageToolOperations): the session's tool table, the
            one MCP and the tool routes share.
    """

    def __init__(
        self,
        entry: WorkspaceEntry,
        jobs: ExecutionTable,
        session_id: str,
        operations: MirageToolOperations,
    ) -> None:
        super().__init__(entry.runner.ws, session_id, operations)
        self._entry = entry
        self._jobs = jobs

    async def run_line(
        self,
        command: str,
        cwd: str | None,
        env: dict[str, str] | None,
        stdin: bytes | None,
    ) -> JsonValue:
        """Run one shell line as a daemon job.

        Args:
            command (str): the line.
            cwd (str | None): a working directory for this line only.
            env (dict[str, str] | None): variables for this line only.
            stdin (bytes | None): the line's stdin.

        Returns:
            JsonValue: ``{kind, exit_code, stdout, stderr, refusal}``.

        Raises:
            RpcError: the job was cancelled or failed.
        """
        runner = self._entry.runner
        session_id = self._session_id

        async def line(scope: ExecutionScope) -> JsonValue:
            io = await runner.ws.shell(
                command,
                session_id=session_id,
                stdin=stdin,
                cwd=cwd,
                env=env,
                execution_scope=scope,
            )
            return await io_result_to_dict(io)

        async def run(scope: ExecutionScope) -> JsonValue:
            return await runner.call(line(scope))

        job = self._jobs.submit(
            workspace_id=self._entry.id,
            command=command,
            factory=run,
            session_id=session_id,
        )
        job = await self._jobs.join(job.id)
        if job.status == ExecutionStatus.CANCELED:
            raise RpcError(RPC_REQUEST_CANCELLED, "job canceled")
        if job.status == ExecutionStatus.FAILED:
            raise RpcError(RPC_INTERNAL_ERROR, job.error or "shell failed")
        return job.result

    async def hop(self, work: Coroutine[Any, Any, T]) -> T:
        """Run a Session call on the workspace's loop.

        Args:
            work (Coroutine[Any, Any, T]): the call.

        Returns:
            T: its result.
        """
        return await self._entry.runner.call(work)


class RpcEndpoint:
    """Serves every workspace's Session API over JSON-RPC on HTTP.

    Each ``POST /v1/workspaces/{id}/rpc`` carries one message or a batch
    and is answered with the responses. The endpoint is stateless, as the
    MCP one is: ``?session_id=`` names the session, else the default, and
    the tool table is the one MCP serves the session with. A request
    still running is held in ``inflight``, so ``$/cancelRequest`` on
    another request reaches it, and a caller that drops the request
    cancels it.

    Args:
        registry (WorkspaceRegistry): the daemon's workspaces.
        jobs (ExecutionTable): the daemon's execution table.
        mcp (McpEndpoint): the MCP endpoint, which owns the tool tables.
    """

    def __init__(
        self,
        registry: WorkspaceRegistry,
        jobs: ExecutionTable,
        mcp: McpEndpoint,
    ) -> None:
        self._registry = registry
        self._jobs = jobs
        self._mcp = mcp
        self.inflight = InFlight()

    async def server(
        self,
        workspace_id: str,
        session_id: str | None,
        account: str | None,
    ) -> DaemonRpcServer:
        """The RPC server for a workspace session.

        Args:
            workspace_id (str): the workspace.
            session_id (str | None): the session; None is the default.
            account (str | None): the caller's account; another
                account's workspace is not found.

        Returns:
            DaemonRpcServer: the server.

        Raises:
            LookupError: the workspace or the session does not exist.
        """
        operations = await self._mcp.tools(workspace_id, session_id, account)
        entry = self._registry.get(workspace_id)
        return DaemonRpcServer(
            entry,
            self._jobs,
            session_id or entry.runner.ws.default_session_id,
            operations,
        )

    async def handle(self, request: Request) -> Response:
        """Answer one HTTP request of JSON-RPC messages.

        Args:
            request (Request): the HTTP request.

        Returns:
            Response: the responses, or 204 when only notifications came.
        """
        workspace_id = request.path_params["workspace_id"]
        try:
            server = await self.server(
                workspace_id,
                request.query_params.get("session_id"),
                request.state.account,
            )
        except LookupError as exc:
            return JSONResponse({"detail": exc.args[0]}, status_code=404)
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > DEFAULT_MAX_REQUEST_BODY_SIZE:
                return JSONResponse(
                    {"detail": "request body too large"}, status_code=413
                )
        try:
            parsed = json.loads(body)
        except ValueError:
            return JSONResponse(
                error_response(None, RPC_PARSE_ERROR, "parse error")
            )
        batch = isinstance(parsed, list)
        messages = parsed if isinstance(parsed, list) else [parsed]
        session_id = server.session_id

        async def answer(message: Message) -> RpcResponse | None:
            try:
                return await server.handle(message)
            except asyncio.CancelledError:
                return error_response(
                    message.get("id"),
                    RPC_REQUEST_CANCELLED,
                    "request cancelled",
                )

        answers: list[asyncio.Task[RpcResponse | None] | RpcResponse] = []
        held: list[tuple[str, asyncio.Task[RpcResponse | None]]] = []
        for message in messages:
            if not isinstance(message, dict):
                answers.append(
                    error_response(
                        None, RPC_INVALID_REQUEST, "a message is an object"
                    )
                )
                continue
            if message.get("method") == CANCEL_REQUEST:
                params = message.get("params")
                if isinstance(params, dict):
                    self.inflight.cancel(
                        InFlight.key(
                            workspace_id, session_id, params.get("id")
                        )
                    )
                continue
            task = asyncio.ensure_future(answer(message))
            if "id" in message:
                key = InFlight.key(workspace_id, session_id, message["id"])
                self.inflight.add(key, task.cancel)
                held.append((key, task))
            answers.append(task)
        tasks = [a for a in answers if isinstance(a, asyncio.Task)]

        async def caller_gone() -> None:
            while (await request.receive())["type"] != "http.disconnect":
                pass
            for task in tasks:
                task.cancel()

        watcher = asyncio.ensure_future(caller_gone())
        try:
            if tasks:
                await asyncio.wait(tasks)
        finally:
            watcher.cancel()
            for key, task in held:
                self.inflight.discard(key, task.cancel)
        responses = [
            response
            for response in (
                a.result() if isinstance(a, asyncio.Task) else a
                for a in answers
            )
            if response is not None
        ]
        if not responses:
            return Response(status_code=204)
        return JSONResponse(responses if batch else responses[0])


def register_rpc_routes(
    app: FastAPI,
    registry: WorkspaceRegistry,
    jobs: ExecutionTable,
    mcp: McpEndpoint,
) -> None:
    """Serve JSON-RPC at ``/v1/workspaces/{workspace_id}/rpc``.

    The route sits behind the app's host check and auth, as every other
    route does.

    Args:
        app (FastAPI): the daemon app.
        registry (WorkspaceRegistry): the daemon's workspaces.
        jobs (ExecutionTable): the daemon's execution table.
        mcp (McpEndpoint): the MCP endpoint, which owns the tool tables.
    """
    endpoint = RpcEndpoint(registry, jobs, mcp)
    app.router.routes.append(
        Route(
            RPC_PATH,
            endpoint.handle,
            methods=["POST"],
            include_in_schema=False,
        )
    )
