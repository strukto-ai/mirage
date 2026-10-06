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

from collections.abc import AsyncGenerator, Callable
from typing import Any

import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.server import Server, ServerRequestContext
from mcp.server.stdio import stdio_server
from mcp.types import (
    CallToolRequestParams,
    CallToolResult,
    ListToolsResult,
    PaginatedRequestParams,
)

from mirage import __version__
from mirage.concurrency.limiter import run_blocking


class McpRelay:
    """Answers MCP over one stream by asking the daemon's HTTP endpoint.

    Every way into mirage's MCP tools ends at the daemon's
    ``/v1/workspaces/{id}/mcp``: the stdio CLI only carries messages to
    it, so auth, sessions, jobs and history are decided in one place.

    Args:
        upstream (Client): an MCP client connected to the endpoint.
    """

    def __init__(self, upstream: Client) -> None:
        self._upstream = upstream
        self.server: Server[dict[str, Any]] = Server(
            "mirage",
            version=__version__,
            on_list_tools=self.list_tools,
            on_call_tool=self.call_tool,
        )

    async def list_tools(
        self,
        ctx: ServerRequestContext[dict[str, Any]],
        params: PaginatedRequestParams | None,
    ) -> ListToolsResult:
        """Report the endpoint's tool table.

        Args:
            ctx (ServerRequestContext[dict[str, Any]]): the request
                context; unused.
            params (PaginatedRequestParams | None): the page cursor.

        Returns:
            ListToolsResult: the endpoint's answer.
        """
        cursor = params.cursor if params is not None else None
        return await self._upstream.list_tools(cursor=cursor)

    async def call_tool(
        self,
        ctx: ServerRequestContext[dict[str, Any]],
        params: CallToolRequestParams,
    ) -> CallToolResult:
        """Run one tool call at the endpoint.

        Args:
            ctx (ServerRequestContext[dict[str, Any]]): the request
                context; unused.
            params (CallToolRequestParams): the tool name and arguments.

        Returns:
            CallToolResult: the endpoint's answer; its protocol errors
                propagate as this server's.
        """
        return await self._upstream.call_tool(
            params.name, params.arguments or {}
        )


async def relay_stdio(url: str, token: Callable[[], str]) -> None:
    """Relay this process's stdio to a daemon's MCP endpoint.

    A tool call may run for as long as its command does, so reads are
    not timed.

    Args:
        url (str): the workspace's ``/v1/workspaces/{id}/mcp`` URL.
        token (Callable[[], str]): the bearer token, asked for on every
            request, so a login refreshed while the relay runs is sent;
            empty sends none.
    """

    class Bearer(httpx2.Auth):
        async def async_auth_flow(
            self, request: httpx2.Request
        ) -> AsyncGenerator[httpx2.Request, httpx2.Response]:
            value = await run_blocking(token)
            if value:
                request.headers["Authorization"] = f"Bearer {value}"
            yield request

    async with (
        httpx2.AsyncClient(
            auth=Bearer(), timeout=httpx2.Timeout(30.0, read=None)
        ) as http,
        Client(streamable_http_client(url, http_client=http)) as upstream,
        stdio_server() as (read_stream, write_stream),
    ):
        server = McpRelay(upstream).server
        await server.run(
            read_stream, write_stream, server.create_initialization_options()
        )
