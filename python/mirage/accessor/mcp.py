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
import contextvars
import logging
from collections import Counter
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx2
from mcp import Client, types
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.exceptions import MCPError

from mirage.accessor.base import Accessor
from mirage.core.mcp.config import MCPConfig
from mirage.io.gateway import live_egress
from mirage.io.network import NetworkRule, network_bound, run_with_network
from mirage.types import JsonValue

logger = logging.getLogger(__name__)

TIMEOUT = httpx2.Timeout(30.0, read=300.0)
MAX_PAGES = 64


def answered(error: Exception) -> bool:
    """Whether the server read the request and refused it, which says
    nothing against the connection: a JSON-RPC error outside the codes
    the SDK spends on transport, timeout and session faults.

    Args:
        error (Exception): what the call raised.
    """
    if not isinstance(error, MCPError):
        return False
    return error.code in (
        types.INVALID_PARAMS,
        types.METHOD_NOT_FOUND,
    ) or not (-32768 <= error.code <= -32000)


class MCPAccessor(Accessor):
    """A streamable-HTTP MCP server, one client kept per install.

    An owner task opens the client under the network rule of the call
    that opened it and waits inside its ``async with``, since the SDK
    closes a client only from the task that opened it. A call whose
    session a network policy listens to, or that is held to another
    rule, opens a client of its own, so its connection is judged as its
    own. A call that fails drops the kept client, unless the server
    answered it with an error: the next call reopens one, and the dropped
    one closes once the calls running on it end.
    """

    def __init__(self, config: MCPConfig) -> None:
        """Args:
        config (MCPConfig): the server's URL and auth.
        """
        self.config = config
        self._owner: asyncio.Task[None] | None = None
        self._opened: asyncio.Future[Client] | None = None
        self._stop = asyncio.Event()
        self._rule: NetworkRule | None = None
        self._owners: set[asyncio.Task[None]] = set()
        self._calls: Counter[asyncio.Event] = Counter()
        self._dropped: set[asyncio.Event] = set()

    def headers(self) -> dict[str, str]:
        """The one header `auth` asks for; none without auth."""
        auth = self.config.auth
        if auth is None:
            return {}
        token = auth.token.get_secret_value()
        if auth.type == "bearer":
            return {"Authorization": f"Bearer {token}"}
        return {str(auth.name): token}

    @asynccontextmanager
    async def session(self) -> AsyncIterator[Client]:
        """An initialized client, closed when the block ends."""
        async with httpx2.AsyncClient(
            headers=self.headers(), timeout=TIMEOUT
        ) as http:
            transport = streamable_http_client(
                self.config.url, http_client=http
            )
            async with Client(transport) as client:
                yield client

    async def list_tools(self) -> tuple[str, list[types.Tool]]:
        """The server's title and every tool it lists, page by page."""
        async with self.session() as client:
            page = await client.list_tools()
            tools = list(page.tools)
            pages = 1
            while page.next_cursor:
                if pages == MAX_PAGES:
                    raise ValueError(
                        f"the tool list did not end within {MAX_PAGES} pages"
                    )
                cursor = page.next_cursor
                previous, page = page, await client.list_tools(cursor=cursor)
                if page.next_cursor == cursor and page.tools == previous.tools:
                    break
                tools += page.tools
                pages += 1
            info = client.server_info
            title = (info.title or info.name) if info is not None else ""
            return title, tools

    async def _own(
        self, opened: "asyncio.Future[Client]", stop: asyncio.Event
    ) -> None:
        try:
            async with self.session() as client:
                opened.set_result(client)
                await stop.wait()
        except Exception as error:
            if opened.done():
                logger.debug("MCP client close failed: %r", error)
            else:
                opened.set_exception(error)
        finally:
            if not opened.done():
                opened.cancel()

    def _kept(
        self, rule: NetworkRule | None
    ) -> "asyncio.Future[Client] | None":
        """The kept client's opening, started when there is none; None
        when it was opened under another rule than ``rule``.

        Args:
            rule (NetworkRule | None): the calling line's network rule.
        """
        if self._owner is not None and not (
            self._owner.done()
            or self._stop.is_set()
            or self._stop in self._dropped
        ):
            return self._opened if self._rule is rule else None
        self._rule, self._stop = rule, asyncio.Event()
        self._opened = asyncio.get_running_loop().create_future()
        self._owner = asyncio.create_task(
            run_with_network(rule, self._own(self._opened, self._stop)),
            context=contextvars.Context(),
        )
        self._owners.add(self._owner)
        self._owner.add_done_callback(self._owners.discard)
        return self._opened

    async def call_tool(
        self, name: str, arguments: dict[str, JsonValue]
    ) -> types.CallToolResult:
        """Call one tool, on the kept client unless a network policy
        listens to the calling session or it is held to another rule.

        Args:
            name (str): the tool's MCP name.
            arguments (dict[str, JsonValue]): its arguments object.
        """
        opened = None
        if not any(egress.hooked for egress in live_egress()):
            opened = self._kept(network_bound())
        if opened is None:
            async with self.session() as client:
                return await client.call_tool(name, arguments)
        stop = self._stop
        self._calls[stop] += 1
        try:
            client = await asyncio.shield(opened)
            return await client.call_tool(name, arguments)
        except Exception as error:
            if not answered(error):
                self._dropped.add(stop)
            raise
        finally:
            self._calls[stop] -= 1
            if not self._calls[stop]:
                del self._calls[stop]
                if stop in self._dropped:
                    self._dropped.discard(stop)
                    stop.set()

    async def close(self) -> None:
        """Close the kept client and any dropped one, waiting for their
        owners to let go."""
        for stop in (self._stop, *self._dropped):
            stop.set()
        self._dropped.clear()
        await asyncio.gather(*self._owners)
