import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import pytest

pytest.importorskip("openenv")
pytest.importorskip("fastmcp")

import httpx
import uvicorn
from fastmcp import Client
from openenv.core.env_server.mcp_types import (
    CallToolAction,
    ListToolsAction,
)
from openenv.core.env_server.types import Action, Observation
from openenv.core.rubrics import Rubric

from mirage import RAMVFS, MountMode, Workspace
from mirage.environments.openenv import (
    MirageMCPTransport,
    MirageServerEnv,
    mirage_server_transport,
)
from mirage.server import build_app
from mirage.server.auth import AuthConfig, AuthMode
from mirage.server.mcp import MirageMcpServer

CONFIG = {"config": {"mounts": {"/": {"vfs": "ram", "mode": "WRITE"}}}}


@asynccontextmanager
async def daemon(
    tmp_path, auth_config: AuthConfig | None = None
) -> AsyncIterator[str]:
    app = build_app(pid_file=tmp_path / "daemon.pid", auth_config=auth_config)
    server = uvicorn.Server(
        uvicorn.Config(
            app, host="127.0.0.1", port=0, log_level="warning", ws="none"
        )
    )
    task = asyncio.create_task(server.serve())
    try:
        async with asyncio.timeout(10):
            while not server.started:
                if task.done():
                    raise RuntimeError("the server stopped before it started")
                await asyncio.sleep(0.01)
        port = server.servers[0].sockets[0].getsockname()[1]
        yield f"http://127.0.0.1:{port}"
    finally:
        if server.started:
            server.should_exit = True
            await task
        else:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


async def create_workspace(base: str, token: str | None = None) -> str:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with httpx.AsyncClient(base_url=base, headers=headers) as http:
        created = await http.post("/v1/workspaces", json=CONFIG)
    assert created.status_code == 201
    return created.json()["id"]


@pytest.mark.asyncio
async def test_the_transport_runs_a_low_level_server_in_process():
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo hi > /data/a.txt")
    server = MirageMcpServer(ws)
    async with Client(MirageMCPTransport(server.server)) as client:
        tools = await client.list_tools()
        read = await client.call_tool("read", {"path": "/data/a.txt"})
    await ws.close()

    assert {t.name for t in tools} == {
        "shell",
        "read",
        "write",
        "edit",
        "ls",
        "grep",
        "glob",
    }
    assert read.content[0].text == "     1\thi\n"


def test_the_server_transport_names_the_workspace_endpoint():
    transport = mirage_server_transport(
        "http://127.0.0.1:8765/",
        "ws/1",
        token="secret",
        session_id="agent",
    )
    tools_only = mirage_server_transport(
        "http://127.0.0.1:8765", "abc", calls="tools"
    )

    assert transport.url == (
        "http://127.0.0.1:8765/v1/workspaces/ws%2F1/mcp"
        "?calls=all&session_id=agent"
    )
    assert "secret" not in transport.url
    assert tools_only.url == (
        "http://127.0.0.1:8765/v1/workspaces/abc/mcp?calls=tools"
    )


@pytest.mark.parametrize(
    "base_url",
    ["http://localhost:8765", "http://[::1]:8765", "https://mirage.example"],
)
def test_the_server_transport_sends_a_token_over_a_safe_url(base_url):
    transport = mirage_server_transport(base_url, "abc", token="secret")

    assert transport.url.startswith(base_url)


def test_the_server_transport_refuses_a_token_over_remote_http():
    with pytest.raises(ValueError, match="plain http"):
        mirage_server_transport(
            "http://mirage.example:8765", "abc", token="secret"
        )


class Succeeded(Rubric):
    def forward(self, action: Action, observation: Observation) -> float:
        return 0.0 if getattr(observation, "error", None) else 1.0


@pytest.mark.asyncio
async def test_the_server_env_reaches_a_workspace_a_mirage_server_holds(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    auth = AuthConfig(mode=AuthMode.LOCAL, local_token="secret")
    async with daemon(tmp_path, auth) as base:
        workspace_id = await create_workspace(base, "secret")
        env = MirageServerEnv(
            base, workspace_id, token="secret", rubric=Succeeded()
        )
        await env.reset_async(episode_id="ep-1")
        listed = await env.step_async(ListToolsAction())
        wrote = await env.step_async(
            CallToolAction(
                tool_name="write",
                arguments={"path": "/a.txt", "content": "hi\n"},
            )
        )
        stat = await env.step_async(
            CallToolAction(
                tool_name="vfs_exists", arguments={"path": "/a.txt"}
            )
        )
        state = env.state
        await env.reset_async()
        kept = await env.step_async(
            CallToolAction(tool_name="read", arguments={"path": "/a.txt"})
        )
        with pytest.raises(TypeError, match="ListToolsAction"):
            await env.step_async(Action())
        refused = MirageServerEnv(base, workspace_id)
        unauthorized = await refused.step_async(ListToolsAction())
        env.close()

    names = {tool.name for tool in listed.tools}
    assert {"shell", "read", "vfs_read", "vfs_exists"} <= names
    assert wrote.error is None
    assert wrote.reward == 1.0
    assert stat.result.content[0].text == '{"exists":true}'
    assert (state.episode_id, state.step_count) == ("ep-1", 2)
    assert env.state.step_count == 1
    assert kept.result.content[0].text == "     1\thi\n"
    assert stat.result.data == '{"exists":true}'
    assert kept.result.data == "     1\thi\n"
    assert unauthorized.tools == []
    assert "error" in unauthorized.metadata
