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
import gzip
import json
import zlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

import anyio
import uvicorn
from mcp import types
from mcp.server.context import ServerRequestContext
from mcp.server.lowlevel import Server
from mcp.shared.exceptions import MCPError
from starlette.types import ASGIApp, Receive, Scope, Send

from mirage.core.mcp.constants import MAX_REPLY
from mirage.types import JsonValue

TOKEN = "fixture-token"
API_KEY = "fixture-key"
PAGE = 2
TITLE = "Fixture Tools"

TOOLS = [
    types.Tool(
        name="list_items",
        description="List the items.\nEvery item, oldest first.",
        input_schema={"type": "object", "properties": {}},
        annotations=types.ToolAnnotations(read_only_hint=True),
    ),
    types.Tool(
        name="add_item",
        description="Add an item.",
        input_schema={
            "type": "object",
            "properties": {"name": {"type": "string"}},
            "required": ["name"],
        },
    ),
    types.Tool(
        name="fail_always",
        description="Always fails.",
        input_schema={"type": "object"},
    ),
    types.Tool(
        name="wait_forever",
        description="Never answers.",
        input_schema={"type": "object"},
    ),
    types.Tool(
        name="echo_args",
        description="Echo the arguments back.",
        input_schema={"type": "object"},
    ),
]


@dataclass
class FakeMCP:
    """A running fixture server and what it saw.

    Args:
        url (str): the streamable-HTTP endpoint.
        requests (list[dict[str, str]]): one entry per HTTP request,
            with its method, MCP method, MCP session id, the auth
            headers it carried and the encodings it accepts.
        started (list[str]): tools whose call began.
        cancelled (list[str]): tools whose call was abandoned.
        expired (set[str]): MCP session ids answered 404 from now on.
        pages (int | None): list the tools over exactly this many pages,
            empty past the last tool.
        repeating (bool): every tool page is the first, naming itself
            as the next.
        page_delay (float): seconds each tool page waits before it
            answers.
        hung_delete (bool): a DELETE, which ends an MCP session, is not
            answered until this is cleared.
        down (bool): every request is answered 503.
        oversized (dict[str, str]): MCP methods answered with a body
            past the reply cap, of the content type each maps to.
        encoding (str | None): ``tools/call`` is answered with the
            text ``inflated``, gzip-compressed and labelled with this
            content encoding, whatever the client accepts.
        padding (int): bytes of ``_meta`` padding in that answer, which
            no rendering prints.
        damage (str | None): ``truncated``, ``garbled`` or ``trailing``
            (bytes after the end) spoils that answer's compressed body,
            sent as one chunk.
    """

    url: str
    requests: list[dict[str, str]] = field(default_factory=list)
    started: list[str] = field(default_factory=list)
    cancelled: list[str] = field(default_factory=list)
    expired: set[str] = field(default_factory=set)
    pages: int | None = None
    repeating: bool = False
    page_delay: float = 0.0
    hung_delete: bool = False
    down: bool = False
    oversized: dict[str, str] = field(default_factory=dict)
    encoding: str | None = None
    padding: int = 0
    damage: str | None = None

    def opens(self) -> int:
        """How many clients connected: each probes ``server/discover``
        once, before a legacy server's ``initialize``."""
        return sum(1 for r in self.requests if r["mcp"] == "server/discover")

    def bearer_config(self) -> dict[str, JsonValue]:
        """An MCP CLI config that reaches this server with its token."""
        return {"url": self.url, "auth": {"type": "bearer", "token": TOKEN}}

    def expire(self) -> None:
        """Answer 404 to every MCP session seen so far, as a legacy server
        that restarted or timed them out does."""
        self.expired |= {r["session"] for r in self.requests if r["session"]}


def _text(text: str, error: bool = False) -> types.CallToolResult:
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=text)], is_error=error
    )


def _server(fake: FakeMCP, tools: list[types.Tool]) -> Server:
    async def list_tools(
        ctx: ServerRequestContext[Any],
        params: types.PaginatedRequestParams | None,
    ) -> types.ListToolsResult:
        await anyio.sleep(fake.page_delay)
        start = int(params.cursor) if params and params.cursor else 0
        if fake.repeating:
            return types.ListToolsResult(tools=tools[:PAGE], next_cursor="0")
        if fake.pages is not None:
            return types.ListToolsResult(
                tools=tools[start * PAGE : (start + 1) * PAGE],
                next_cursor=str(start + 1) if start + 1 < fake.pages else None,
            )
        end = start + PAGE
        return types.ListToolsResult(
            tools=tools[start:end],
            next_cursor=str(end) if end < len(tools) else None,
        )

    async def call_tool(
        ctx: ServerRequestContext[Any], params: types.CallToolRequestParams
    ) -> types.CallToolResult:
        arguments = params.arguments or {}
        if params.name not in {tool.name for tool in tools}:
            raise MCPError(types.INVALID_PARAMS, f"no tool {params.name}")
        fake.started.append(params.name)
        if params.name == "list_items":
            return _text("apple\nbanana")
        if params.name == "add_item":
            return _text(f"added {arguments.get('name')}")
        if params.name == "fail_always":
            if arguments.get("quiet"):
                return types.CallToolResult(content=[], is_error=True)
            return _text("boom", error=True)
        if params.name == "wait_forever":
            try:
                await anyio.sleep_forever()
            finally:
                fake.cancelled.append(params.name)
        return _text(json.dumps(arguments, sort_keys=True))

    return Server(
        "fixture",
        title=TITLE,
        on_list_tools=list_tools,
        on_call_tool=call_tool,
    )


async def _answer(send: Send, status: int, body: bytes) -> None:
    await send(
        {"type": "http.response.start", "status": status, "headers": []}
    )
    await send({"type": "http.response.body", "body": body})


async def _flood(send: Send, content_type: str) -> None:
    await send(
        {
            "type": "http.response.start",
            "status": 200,
            "headers": [(b"content-type", content_type.encode())],
        }
    )
    chunk = b"x" * (1024 * 1024)
    await send(
        {
            "type": "http.response.body",
            "body": b"event: message\ndata: ",
            "more_body": True,
        }
    )
    for _ in range(MAX_REPLY // len(chunk) + 1):
        await send(
            {"type": "http.response.body", "body": chunk, "more_body": True}
        )
    await send({"type": "http.response.body", "body": b"\n\n"})


async def _encoded(fake: FakeMCP, receive: Receive, send: Send) -> None:
    body = b""
    while True:
        message = await receive()
        body += message.get("body", b"")
        if not message.get("more_body"):
            break
    reply = {
        "jsonrpc": "2.0",
        "id": json.loads(body)["id"],
        "result": {
            "content": [{"type": "text", "text": "inflated"}],
            "_meta": {"padding": "x" * fake.padding},
            "resultType": "complete",
        },
    }
    pack = zlib.compress if fake.encoding == "deflate" else gzip.compress
    packed = pack(json.dumps(reply).encode())
    if fake.damage == "truncated":
        packed = packed[: len(packed) // 2]
    elif fake.damage == "garbled":
        packed = packed[:10] + b"\xff" * 32
    elif fake.damage == "trailing":
        packed += b"JUNK"
    await send(
        {
            "type": "http.response.start",
            "status": 200,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-encoding", str(fake.encoding).encode()),
            ],
        }
    )
    await send(
        {
            "type": "http.response.body",
            "body": packed,
        }
    )


def _guard(app: ASGIApp, fake: FakeMCP, legacy: bool) -> ASGIApp:
    async def guarded(scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await app(scope, receive, send)
            return
        headers = {k.decode(): v.decode() for k, v in scope["headers"]}
        session = headers.get("mcp-session-id", "")
        mcp = headers.get("mcp-method", "")
        fake.requests.append(
            {
                "method": scope["method"],
                "mcp": mcp,
                "session": session,
                "authorization": headers.get("authorization", ""),
                "x-api-key": headers.get("x-api-key", ""),
                "accept-encoding": headers.get("accept-encoding", ""),
            }
        )
        while fake.hung_delete and scope["method"] == "DELETE":
            await anyio.sleep(0.05)
        if fake.down:
            await _answer(send, 503, b"down")
        elif (
            headers.get("authorization") != f"Bearer {TOKEN}"
            and headers.get("x-api-key") != API_KEY
        ):
            await _answer(send, 401, b"denied")
        elif session in fake.expired:
            await _answer(send, 404, b"expired")
        elif mcp in fake.oversized:
            await _flood(send, fake.oversized[mcp])
        elif fake.encoding is not None and mcp == "tools/call":
            await _encoded(fake, receive, send)
        elif legacy and mcp == "server/discover":
            await _answer(send, 400, b"legacy")
        else:
            await app(scope, receive, send)

    return guarded


@asynccontextmanager
async def served_mcp(
    tools: list[types.Tool] | None = None,
    legacy: bool = False,
) -> AsyncIterator[FakeMCP]:
    """Serve the fixture MCP server over streamable HTTP on a free port.

    It accepts `Authorization: Bearer fixture-token` or
    `x-api-key: fixture-key` and answers 401 otherwise.

    Args:
        tools (list[types.Tool] | None): the tool list; defaults to TOOLS.
        legacy (bool): refuse ``server/discover``, so a client falls back
            to ``initialize`` and an MCP session id, as pre-2026 servers.
    """
    fake = FakeMCP(url="")
    app = _server(
        fake, TOOLS if tools is None else tools
    ).streamable_http_app()
    server = uvicorn.Server(
        uvicorn.Config(
            _guard(app, fake, legacy),
            host="127.0.0.1",
            port=0,
            log_level="warning",
            ws="none",
        )
    )
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    fake.url = f"http://127.0.0.1:{port}/mcp"
    try:
        yield fake
    finally:
        fake.hung_delete = False
        server.should_exit = True
        await task
