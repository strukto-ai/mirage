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

import ipaddress
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import partial
from typing import Any, Literal
from urllib.parse import quote, urlencode, urlsplit

import anyio
from mcp import ClientSession
from mcp.server import Server
from mcp.shared.memory import create_client_server_memory_streams
from pydantic import JsonValue

try:
    from fastmcp import Client
    from fastmcp.client.client import CallToolResult
    from fastmcp.client.transports import StreamableHttpTransport
    from fastmcp.client.transports.base import (
        ClientTransport,
        TransportOptions,
    )
    from openenv.core.env_server.interfaces import Transform
    from openenv.core.env_server.mcp_environment import MCPEnvironment
    from openenv.core.env_server.mcp_types import CallToolAction
    from openenv.core.env_server.types import Action, Observation, State
    from openenv.core.rubrics import Rubric
except ImportError as exc:
    raise ImportError(
        "`openenv` not installed. Install with: "
        "pip install 'openenv @ git+https://github.com/openenv/OpenEnv'"
    ) from exc

from mirage.environments.openenv.convert import with_text_data


class MirageToolClient(Client[ClientTransport]):
    """FastMCP's client, with a Mirage tool's text as the result's
    ``data``, so OpenEnv's ``MCPToolClient.call_tool`` returns it on
    every route, ``step`` and the ``/mcp`` JSON-RPC alike.

    Args:
        *args (Any): FastMCP ``Client``'s arguments.
        **kwargs (Any): FastMCP ``Client``'s keyword arguments.
    """

    async def call_tool(self, *args: Any, **kwargs: Any) -> CallToolResult:
        return with_text_data(await super().call_tool(*args, **kwargs))


class MirageMCPTransport(ClientTransport):
    """An in-process MCP connection to a low-level MCP server, such as
    ``MirageMcpServer(ws).server``.

    FastMCP's ``Client`` connects in memory only to its own servers;
    this transport runs any ``mcp.server.Server`` on the client's loop
    for each connection, so ``MCPEnvironment`` can hold a Mirage
    workspace's tools without a socket.

    Args:
        server (Server[dict[str, Any]]): The server each connection
            runs.
    """

    def __init__(self, server: Server[dict[str, Any]]) -> None:
        self.server = server

    @asynccontextmanager
    async def connect_session(
        self,
        *,
        transport_options: TransportOptions | None = None,
        **session_kwargs: Any,
    ) -> AsyncIterator[ClientSession]:
        options = transport_options or TransportOptions()
        failure: BaseException | None = None
        async with create_client_server_memory_streams() as (
            (client_read, client_write),
            (server_read, server_write),
        ):
            async with anyio.create_task_group() as tasks:
                tasks.start_soon(
                    partial(
                        self.server.run,
                        server_read,
                        server_write,
                        self.server.create_initialization_options(),
                    )
                )
                try:
                    async with options.session_class(
                        read_stream=client_read,
                        write_stream=client_write,
                        **session_kwargs,
                    ) as session:
                        yield session
                except BaseException as exc:
                    failure = exc
                finally:
                    tasks.cancel_scope.cancel()
        if failure is not None:
            raise failure


def secure_for_token(base_url: str) -> bool:
    """Whether a bearer token may travel to ``base_url``: over https,
    or over plain http to a loopback host.

    Args:
        base_url (str): The server's base URL.
    """
    parts = urlsplit(base_url)
    if parts.scheme != "http":
        return True
    host = parts.hostname or ""
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def mirage_server_transport(
    base_url: str,
    workspace_id: str,
    *,
    token: str | None = None,
    session_id: str | None = None,
    calls: Literal["tools", "all"] = "all",
) -> StreamableHttpTransport:
    """The MCP endpoint of a workspace a Mirage server holds,
    ``/v1/workspaces/{id}/mcp``, as a FastMCP transport.

    Args:
        base_url (str): The server's base URL, such as
            ``http://127.0.0.1:8765``.
        workspace_id (str): The workspace to serve.
        token (str | None): The bearer token, sent in the
            ``Authorization`` header; None for a server without auth.
            Over plain ``http://`` it goes to a loopback host only.
        session_id (str | None): The session the tools act as; None is
            the workspace's default session.
        calls (Literal["tools", "all"]): ``all`` also serves every VFS
            call as a ``vfs_<call>`` tool; ``tools`` serves the seven
            tools only.

    Raises:
        ValueError: A token over plain ``http://`` to a host that is not
            loopback.
    """
    if token is not None and not secure_for_token(base_url):
        raise ValueError(
            f"refusing to send a bearer token over plain http to {base_url}; "
            "use https or a loopback host"
        )
    query: dict[str, str] = {"calls": calls}
    if session_id is not None:
        query["session_id"] = session_id
    url = (
        f"{base_url.rstrip('/')}/v1/workspaces/"
        f"{quote(workspace_id, safe='')}/mcp?{urlencode(query)}"
    )
    return StreamableHttpTransport(url, auth=token)


class MirageServerEnv(MCPEnvironment):
    """A workspace a Mirage server holds, as an OpenEnv MCP environment.

    ``ListToolsAction`` and ``CallToolAction`` reach the workspace's
    ``/v1/workspaces/{id}/mcp`` endpoint: Mirage's seven tools and,
    with ``calls="all"``, every ``vfs_<call>``, judged by the session's
    profile on the server. The server owns the workspace, so ``reset``
    starts a new episode count and rubric trajectory but leaves the
    files as they are; for a fresh workspace per episode, run
    ``MirageOpenEnv`` in process.

    Args:
        base_url (str): The server's base URL.
        workspace_id (str): The workspace to serve.
        token (str | None): The bearer token; None for a server without
            auth.
        session_id (str | None): The session the tools act as; None is
            the workspace's default session.
        calls (Literal["tools", "all"]): ``all`` also serves the VFS
            calls.
        transform (Transform[Observation] | None): Applied to every
            observation.
        rubric (Rubric | None): Scores each tool call.
    """

    SUPPORTS_CONCURRENT_SESSIONS = True

    def __init__(
        self,
        base_url: str,
        workspace_id: str,
        *,
        token: str | None = None,
        session_id: str | None = None,
        calls: Literal["tools", "all"] = "all",
        transform: Transform[Observation] | None = None,
        rubric: Rubric | None = None,
    ) -> None:
        super().__init__(
            mirage_server_transport(
                base_url,
                workspace_id,
                token=token,
                session_id=session_id,
                calls=calls,
            ),
            transform=transform,
        )
        self.mcp_client = MirageToolClient(self.mcp_server, mode="legacy")
        self.rubric = rubric
        self._state = State()

    @property
    def state(self) -> State:
        return self._state

    def reset(
        self,
        seed: int | None = None,
        episode_id: str | None = None,
        **kwargs: JsonValue,
    ) -> Observation:
        self._reset_rubric()
        self._state = State(episode_id=episode_id or str(uuid.uuid4()))
        return self._apply_transform(Observation())

    async def reset_async(
        self,
        seed: int | None = None,
        episode_id: str | None = None,
        **kwargs: JsonValue,
    ) -> Observation:
        await self._reset_rubric_async()
        self._state = State(episode_id=episode_id or str(uuid.uuid4()))
        return self._apply_transform(Observation())

    def step(
        self,
        action: Action,
        timeout_s: float | None = None,
        **kwargs: JsonValue,
    ) -> Observation:
        observation = super().step(action, timeout_s=timeout_s)
        if isinstance(action, CallToolAction):
            self._state.step_count += 1
            if self.rubric is not None:
                observation.reward = self._apply_rubric(action, observation)
        return self._apply_transform(observation)

    async def step_async(
        self,
        action: Action,
        timeout_s: float | None = None,
        **kwargs: JsonValue,
    ) -> Observation:
        observation = await super().step_async(action, timeout_s=timeout_s)
        if isinstance(action, CallToolAction):
            self._state.step_count += 1
            if self.rubric is not None:
                observation.reward = await self._apply_rubric_async(
                    action, observation
                )
        return self._apply_transform(observation)

    def _step_impl(
        self,
        action: Action,
        timeout_s: float | None = None,
        **kwargs: JsonValue,
    ) -> Observation:
        raise TypeError(
            "MirageServerEnv takes ListToolsAction and CallToolAction, not "
            f"{type(action).__name__}"
        )
