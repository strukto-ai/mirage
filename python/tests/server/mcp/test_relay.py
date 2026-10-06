import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import partial

import anyio
import httpx
import pytest
import uvicorn
from mcp import Client
from mcp.server.stdio import stdio_server
from mcp.shared.exceptions import MCPError

from mirage import RAMVFS, MountMode, Workspace
from mirage.server import build_app
from mirage.server.auth import AuthConfig
from mirage.server.mcp import relay
from mirage.server.mcp.relay import McpRelay
from mirage.server.mcp.server import MirageMcpServer


def upstream_server() -> MirageMcpServer:
    return MirageMcpServer(Workspace({"/": RAMVFS()}, mode=MountMode.WRITE))


@pytest.mark.asyncio
async def test_relays_the_tool_table():
    async with Client(upstream_server().server) as upstream:
        upstream_tools = (await upstream.list_tools()).tools
        async with Client(McpRelay(upstream).server) as client:
            relayed = (await client.list_tools()).tools
    assert relayed == upstream_tools


@pytest.mark.asyncio
async def test_relays_a_tool_call():
    async with Client(upstream_server().server) as upstream:
        async with Client(McpRelay(upstream).server) as client:
            await client.call_tool("shell", {"command": "mkdir /d && cd /d"})
            result = await client.call_tool("shell", {"command": "pwd"})
    assert result.content[0].text == "/d\n"
    assert not result.is_error


@pytest.mark.asyncio
async def test_relays_a_protocol_error():
    async with Client(upstream_server().server) as upstream:
        async with Client(McpRelay(upstream).server) as client:
            with pytest.raises(MCPError) as caught:
                await client.call_tool("nope", {})
    assert caught.value.error.code == -32602
    assert caught.value.error.message == "Tool nope not found"


@pytest.mark.asyncio
async def test_passes_a_cancel_on_so_the_next_line_runs_at_once():
    async with Client(upstream_server().server) as upstream:
        async with Client(McpRelay(upstream).server) as client:
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(
                    client.call_tool("shell", {"command": "sleep 20"}), 0.3
                )
            result = await asyncio.wait_for(
                client.call_tool("shell", {"command": "echo after"}), 5
            )
    assert result.content[0].text == "after\n"


@asynccontextmanager
async def daemon(tmp_path, auth: AuthConfig) -> AsyncIterator[str]:
    app = build_app(pid_file=tmp_path / "daemon.pid", auth_config=auth)
    server = uvicorn.Server(
        uvicorn.Config(
            app, host="127.0.0.1", port=0, log_level="warning", ws="none"
        )
    )
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        await task


class Lines:
    """A client's stdin: the lines, then open until ``done`` is set."""

    def __init__(self, lines: list[dict], done: anyio.Event) -> None:
        self.lines = lines
        self.done = done

    async def __aiter__(self):
        for line in self.lines:
            yield json.dumps(line) + "\n"
        await self.done.wait()


class Answers:
    """A client's stdout: keeps each line, and sets ``done`` on ``last``."""

    def __init__(self, last: int, done: anyio.Event) -> None:
        self.text = ""
        self.last = last
        self.done = done

    async def write(self, text: str) -> None:
        self.text += text
        if any(
            json.loads(line).get("id") == self.last
            for line in self.text.splitlines()
        ):
            self.done.set()

    async def flush(self) -> None:
        return None


@pytest.mark.asyncio
async def test_relay_stdio_asks_for_the_token_on_every_request(
    tmp_path, monkeypatch
):
    asked: list[str] = []

    def token() -> str:
        asked.append("secret")
        return "secret"

    auth = AuthConfig(mode="token", bearer_token="secret")
    async with daemon(tmp_path, auth) as base:
        async with httpx.AsyncClient(
            base_url=base, headers={"Authorization": "Bearer secret"}
        ) as http:
            created = await http.post(
                "/v1/workspaces",
                json={
                    "config": {
                        "mounts": {"/": {"vfs": "ram", "mode": "WRITE"}}
                    }
                },
            )
        wid = created.json()["id"]
        done = anyio.Event()
        answers = Answers(3, done)
        stdin = Lines(
            [
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "clientInfo": {"name": "test", "version": "1"},
                    },
                },
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                {"jsonrpc": "2.0", "id": 3, "method": "tools/list"},
            ],
            done,
        )
        monkeypatch.setattr(
            relay,
            "stdio_server",
            partial(stdio_server, stdin=stdin, stdout=answers),
        )
        await relay.relay_stdio(f"{base}/v1/workspaces/{wid}/mcp", token)
    by_id = {
        json.loads(line).get("id"): json.loads(line)
        for line in answers.text.splitlines()
    }
    for n in (2, 3):
        tools = by_id[n]["result"]["tools"]
        assert "shell" in {tool["name"] for tool in tools}
    assert len(asked) >= 3
