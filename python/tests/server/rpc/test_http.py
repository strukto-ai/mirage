import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
import pytest
import uvicorn

from mirage.server import build_app

CONFIG = {"config": {"mounts": {"/": {"vfs": "ram", "mode": "WRITE"}}}}


@asynccontextmanager
async def daemon(tmp_path) -> AsyncIterator[httpx.AsyncClient]:
    app = build_app(pid_file=tmp_path / "daemon.pid")
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
        async with httpx.AsyncClient(
            base_url=f"http://127.0.0.1:{port}", timeout=10
        ) as http:
            yield http
    finally:
        server.should_exit = True
        await task


async def workspace(http: httpx.AsyncClient) -> str:
    created = await http.post("/v1/workspaces", json=CONFIG)
    assert created.status_code == 201
    return created.json()["id"]


def request(request_id: int, method: str, params: dict) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params,
    }


@pytest.mark.asyncio
async def test_answers_a_request_and_a_batch(tmp_path):
    async with daemon(tmp_path) as http:
        wid = await workspace(http)
        one = await http.post(
            f"/v1/workspaces/{wid}/rpc",
            json=request(1, "shell", {"command": "echo hi"}),
        )
        assert one.json()["result"]["stdout"] == "hi\n"
        batch = await http.post(
            f"/v1/workspaces/{wid}/rpc",
            json=[
                request(1, "vfs/exists", {"path": "/"}),
                {"jsonrpc": "2.0", "method": "shell", "params": {}},
                request(2, "nope", {}),
            ],
        )
        answers = batch.json()
        assert answers[0]["result"] == {"exists": True}
        assert answers[1]["error"]["code"] == -32601
        assert len(answers) == 2


@pytest.mark.asyncio
async def test_shell_is_a_daemon_job_in_the_named_session(tmp_path):
    async with daemon(tmp_path) as http:
        wid = await workspace(http)
        await http.post(
            f"/v1/workspaces/{wid}/sessions", json={"session_id": "agent"}
        )
        url = f"/v1/workspaces/{wid}/rpc"
        params = {"session_id": "agent"}
        await http.post(
            url,
            params=params,
            json=request(1, "shell", {"command": "mkdir /d && cd /d"}),
        )
        pwd = await http.post(
            url, params=params, json=request(2, "shell", {"command": "pwd"})
        )
        assert pwd.json()["result"]["stdout"] == "/d\n"
        jobs = await http.get("/v1/jobs", params={"workspace_id": wid})
        assert {job["session_id"] for job in jobs.json()} == {"agent"}


@pytest.mark.asyncio
async def test_cancel_request_reaches_a_running_shell(tmp_path):
    async with daemon(tmp_path) as http:
        wid = await workspace(http)
        url = f"/v1/workspaces/{wid}/rpc"
        running = asyncio.create_task(
            http.post(url, json=request(7, "shell", {"command": "sleep 20"}))
        )
        await asyncio.sleep(0.5)
        cancelled = await http.post(
            url,
            json={
                "jsonrpc": "2.0",
                "method": "$/cancelRequest",
                "params": {"id": 7},
            },
        )
        assert cancelled.status_code == 204
        answer = await asyncio.wait_for(running, 5)
        assert answer.json()["error"]["code"] == -32800
        status = ""
        for _ in range(100):
            jobs = await http.get("/v1/jobs", params={"workspace_id": wid})
            status = jobs.json()[0]["status"]
            if status == "canceled":
                break
            await asyncio.sleep(0.05)
        assert status == "canceled"


@pytest.mark.asyncio
async def test_shares_the_session_tool_table_with_mcp_and_http(tmp_path):
    async with daemon(tmp_path) as http:
        wid = await workspace(http)
        await http.post(
            f"/v1/workspaces/{wid}/write",
            json={"path": "/f.txt", "content": "a\n"},
        )
        await http.post(f"/v1/workspaces/{wid}/read", json={"path": "/f.txt"})
        written = await http.post(
            f"/v1/workspaces/{wid}/rpc",
            json=request(
                1,
                "tools/call",
                {
                    "name": "write",
                    "arguments": {"path": "/f.txt", "content": "b\n"},
                },
            ),
        )
        assert written.json()["result"] == {
            "text": "Written: /f.txt",
            "is_error": False,
        }


@pytest.mark.asyncio
async def test_an_unknown_workspace_or_session_is_not_found(tmp_path):
    async with daemon(tmp_path) as http:
        wid = await workspace(http)
        missing = await http.post(
            "/v1/workspaces/nope/rpc", json=request(1, "initialize", {})
        )
        assert missing.status_code == 404
        session = await http.post(
            f"/v1/workspaces/{wid}/rpc",
            params={"session_id": "nope"},
            json=request(1, "initialize", {}),
        )
        assert session.status_code == 404


@pytest.mark.asyncio
async def test_a_body_over_the_limit_is_refused(tmp_path):
    async with daemon(tmp_path) as http:
        wid = await workspace(http)
        r = await http.post(
            f"/v1/workspaces/{wid}/rpc", content=b" " * (4 * 1024 * 1024 + 1)
        )
        assert r.status_code == 413
