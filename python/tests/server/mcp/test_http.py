import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
import httpx2
import pytest
import uvicorn
from fastapi import FastAPI
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.exceptions import MCPError
from mcp.types import INVALID_PARAMS, CallToolResult

from mirage.server import build_app
from mirage.server.auth import AuthConfig, AuthMode

CONFIG = {"config": {"mounts": {"/": {"vfs": "ram", "mode": "WRITE"}}}}


@asynccontextmanager
async def daemon(
    tmp_path, auth_config: AuthConfig | None = None
) -> AsyncIterator[tuple[str, FastAPI]]:
    app = build_app(pid_file=tmp_path / "daemon.pid", auth_config=auth_config)
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
        yield f"http://127.0.0.1:{port}", app
    finally:
        server.should_exit = True
        await task


async def create_workspace(base: str) -> str:
    async with httpx.AsyncClient(base_url=base) as http:
        created = await http.post("/v1/workspaces", json=CONFIG)
    assert created.status_code == 201
    return created.json()["id"]


async def call(url: str, name: str, arguments: dict) -> CallToolResult:
    async with Client(url) as client:
        return await client.call_tool(name, arguments)


@pytest.mark.asyncio
async def test_serves_the_tools(tmp_path):
    async with daemon(tmp_path) as (base, _):
        url = f"{base}/v1/workspaces/{await create_workspace(base)}/mcp"
        async with Client(url) as client:
            tools = sorted(t.name for t in (await client.list_tools()).tools)
            written = await client.call_tool(
                "write", {"path": "/a.txt", "content": "hi\n"}
            )
            read = await client.call_tool("read", {"path": "/a.txt"})
    assert tools == [
        "edit",
        "glob",
        "grep",
        "ls",
        "read",
        "session",
        "shell",
        "write",
    ]
    assert written.is_error is False
    assert read.content[0].text == "     1\thi\n"


@pytest.mark.asyncio
async def test_the_session_outlives_each_request(tmp_path):
    async with daemon(tmp_path) as (base, _):
        url = f"{base}/v1/workspaces/{await create_workspace(base)}/mcp"
        await call(url, "shell", {"command": "mkdir /d && cd /d"})
        pwd = await call(url, "shell", {"command": "pwd"})
    assert pwd.content[0].text == "/d\n"


@pytest.mark.asyncio
async def test_session_id_names_the_session(tmp_path):
    async with daemon(tmp_path) as (base, _):
        workspace_id = await create_workspace(base)
        async with httpx.AsyncClient(base_url=base) as http:
            await http.post(
                f"/v1/workspaces/{workspace_id}/sessions",
                json={"session_id": "agent"},
            )
        url = f"{base}/v1/workspaces/{workspace_id}/mcp"
        await call(
            f"{url}?session_id=agent",
            "shell",
            {"command": "mkdir /d && cd /d"},
        )
        named = await call(
            f"{url}?session_id=agent", "shell", {"command": "pwd"}
        )
        default = await call(url, "shell", {"command": "pwd"})
    assert named.content[0].text == "/d\n"
    assert default.content[0].text == "/\n"


@pytest.mark.asyncio
async def test_a_read_guards_the_next_requests_edit(tmp_path):
    async with daemon(tmp_path) as (base, app):
        workspace_id = await create_workspace(base)
        url = f"{base}/v1/workspaces/{workspace_id}/mcp"
        await call(url, "write", {"path": "/a.txt", "content": "first"})
        await call(url, "read", {"path": "/a.txt"})
        runner = app.state.registry.get(workspace_id).runner
        await runner.call(runner.ws.vfs.write("/a.txt", b"external"))
        stale = await call(
            url,
            "edit",
            {"path": "/a.txt", "old_string": "external", "new_string": "x"},
        )
    assert stale.is_error is True
    assert "changed since it was last read" in stale.content[0].text


@pytest.mark.asyncio
async def test_an_unknown_workspace_or_session_is_not_found(tmp_path):
    async with daemon(tmp_path) as (base, _):
        workspace_id = await create_workspace(base)
        async with httpx.AsyncClient(base_url=base) as http:
            workspace = await http.post("/v1/workspaces/nope/mcp", json={})
            session = await http.post(
                f"/v1/workspaces/{workspace_id}/mcp?session_id=nope", json={}
            )
    assert workspace.status_code == 404
    assert workspace.json() == {"detail": "workspace not found"}
    assert session.status_code == 404
    assert session.json() == {"detail": "session not found"}


@pytest.mark.asyncio
async def test_an_unknown_tool_is_a_protocol_error(tmp_path):
    async with daemon(tmp_path) as (base, _):
        url = f"{base}/v1/workspaces/{await create_workspace(base)}/mcp"
        async with Client(url) as client:
            with pytest.raises(MCPError) as caught:
                await client.call_tool("nope", {})
    assert caught.value.code == INVALID_PARAMS
    assert caught.value.message == "Tool nope not found"


@pytest.mark.asyncio
@pytest.mark.no_auth_override
async def test_the_endpoint_sits_behind_auth(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    auth = AuthConfig(mode=AuthMode.LOCAL, local_token="secret")
    async with daemon(tmp_path, auth) as (base, _):
        headers = {"Authorization": "Bearer secret"}
        async with httpx.AsyncClient(base_url=base, headers=headers) as http:
            created = await http.post("/v1/workspaces", json=CONFIG)
        url = f"{base}/v1/workspaces/{created.json()['id']}/mcp"
        async with httpx.AsyncClient() as http:
            refused = await http.post(url, json={})
        async with httpx2.AsyncClient(headers=headers) as http:
            transport = streamable_http_client(url, http_client=http)
            async with Client(transport) as client:
                tools = (await client.list_tools()).tools
    assert refused.status_code == 401
    assert len(tools) == 8


@pytest.mark.asyncio
async def test_a_recreated_session_starts_a_fresh_tool_table(tmp_path):
    async with daemon(tmp_path) as (base, app):
        workspace_id = await create_workspace(base)
        sessions = f"/v1/workspaces/{workspace_id}/sessions"
        url = f"{base}/v1/workspaces/{workspace_id}/mcp?session_id=agent"
        async with httpx.AsyncClient(base_url=base) as http:
            await http.post(sessions, json={"session_id": "agent"})
            await call(url, "write", {"path": "/a.txt", "content": "first"})
            await call(url, "read", {"path": "/a.txt"})
            runner = app.state.registry.get(workspace_id).runner
            await runner.call(runner.ws.vfs.write("/a.txt", b"external"))
            await http.delete(f"{sessions}/agent")
            await http.post(sessions, json={"session_id": "agent"})
        edited = await call(
            url,
            "edit",
            {"path": "/a.txt", "old_string": "external", "new_string": "x"},
        )
    assert edited.is_error is False


@pytest.mark.asyncio
async def test_a_write_larger_than_a_mebibyte_goes_through(tmp_path):
    async with daemon(tmp_path) as (base, app):
        workspace_id = await create_workspace(base)
        url = f"{base}/v1/workspaces/{workspace_id}/mcp"
        content = "x" * (2 * 1024 * 1024)
        written = await call(
            url, "write", {"path": "/big.txt", "content": content}
        )
        runner = app.state.registry.get(workspace_id).runner
        stored = await runner.call(runner.ws.vfs.read("/big.txt"))
    assert written.is_error is False
    assert len(stored) == len(content)


@pytest.mark.asyncio
async def test_shell_runs_as_a_daemon_job(tmp_path):
    async with daemon(tmp_path) as (base, _):
        workspace_id = await create_workspace(base)
        url = f"{base}/v1/workspaces/{workspace_id}/mcp"
        await call(url, "shell", {"command": "echo from-mcp"})
        async with httpx.AsyncClient(base_url=base) as http:
            jobs = await http.get(
                "/v1/jobs", params={"workspace_id": workspace_id}
            )
    commands = [job["command"] for job in jobs.json()]
    assert "echo from-mcp" in commands
