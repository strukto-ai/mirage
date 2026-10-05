import asyncio
import io
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
import pytest
import uvicorn

from mirage.server import build_app
from mirage.server.auth import AuthConfig
from mirage.server.rpc import relay

CONFIG = {"config": {"mounts": {"/": {"vfs": "ram", "mode": "WRITE"}}}}


@asynccontextmanager
async def daemon(
    tmp_path, auth: AuthConfig | None = None
) -> AsyncIterator[str]:
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


@pytest.mark.asyncio
async def test_relays_each_line_to_the_endpoint(tmp_path, monkeypatch):
    async with daemon(tmp_path) as base:
        async with httpx.AsyncClient(base_url=base) as http:
            wid = (await http.post("/v1/workspaces", json=CONFIG)).json()["id"]
        lines = [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "shell",
                "params": {"command": "echo hi"},
            },
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
        ]
        stdin = io.StringIO(
            "".join(json.dumps(m) + "\n" for m in lines) + "oops\n"
        )
        stdout = io.StringIO()
        monkeypatch.setattr(relay.sys, "stdin", stdin)
        monkeypatch.setattr(relay.sys, "stdout", stdout)
        await relay.relay_stdio(f"{base}/v1/workspaces/{wid}/rpc", lambda: "")
    answers = [json.loads(line) for line in stdout.getvalue().splitlines()]
    by_id = {answer.get("id"): answer for answer in answers}
    assert by_id[1]["result"]["stdout"] == "hi\n"
    assert by_id[None]["error"]["code"] == -32700
    assert len(answers) == 2


@pytest.mark.asyncio
async def test_asks_for_the_token_on_every_request(tmp_path, monkeypatch):
    asked: list[str] = []

    def token() -> str:
        asked.append("secret")
        return "secret"

    auth = AuthConfig(mode="token", bearer_token="secret")
    async with daemon(tmp_path, auth) as base:
        async with httpx.AsyncClient(
            base_url=base, headers={"Authorization": "Bearer secret"}
        ) as http:
            wid = (await http.post("/v1/workspaces", json=CONFIG)).json()["id"]
        lines = [
            {
                "jsonrpc": "2.0",
                "id": n,
                "method": "shell",
                "params": {"command": f"echo {n}"},
            }
            for n in (1, 2, 3)
        ]
        stdin = io.StringIO("".join(json.dumps(m) + "\n" for m in lines))
        stdout = io.StringIO()
        monkeypatch.setattr(relay.sys, "stdin", stdin)
        monkeypatch.setattr(relay.sys, "stdout", stdout)
        await relay.relay_stdio(f"{base}/v1/workspaces/{wid}/rpc", token)
    answers = [json.loads(line) for line in stdout.getvalue().splitlines()]
    assert sorted(a["result"]["stdout"] for a in answers) == [
        "1\n",
        "2\n",
        "3\n",
    ]
    assert len(asked) == 3
