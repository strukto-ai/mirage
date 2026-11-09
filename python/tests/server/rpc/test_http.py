import asyncio
import base64
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
import pytest
import uvicorn
from fastapi import FastAPI

from mirage.server import build_app

CONFIG = {"config": {"mounts": {"/": {"vfs": "ram", "mode": "WRITE"}}}}


@asynccontextmanager
async def daemon(
    tmp_path,
) -> AsyncIterator[tuple[httpx.AsyncClient, FastAPI]]:
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
            yield http, app
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
    async with daemon(tmp_path) as (http, app):
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
        assert answers[0]["result"] is True
        assert answers[1]["error"]["code"] == -32601
        assert len(answers) == 2


@pytest.mark.asyncio
async def test_shell_is_a_daemon_job_in_the_named_session(tmp_path):
    async with daemon(tmp_path) as (http, app):
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
        lines = app.state.registry.get(wid).runner.ws.line_table.lines()
        assert {line.session_id for line in lines} == {"agent"}


@pytest.mark.asyncio
async def test_cancel_request_reaches_a_running_shell(tmp_path):
    async with daemon(tmp_path) as (http, app):
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
        table = app.state.registry.get(wid).runner.ws.line_table
        signal = None
        for _ in range(100):
            signal = table.lines()[0].signal
            if signal is not None:
                break
            await asyncio.sleep(0.05)
        assert signal == 2


@pytest.mark.asyncio
async def test_shares_the_session_tool_table_with_mcp_and_http(tmp_path):
    async with daemon(tmp_path) as (http, app):
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
    async with daemon(tmp_path) as (http, app):
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
    async with daemon(tmp_path) as (http, app):
        wid = await workspace(http)
        r = await http.post(
            f"/v1/workspaces/{wid}/rpc", content=b" " * (4 * 1024 * 1024 + 1)
        )
        assert r.status_code == 413


@pytest.mark.asyncio
async def test_deleting_a_workspace_answers_a_held_stdin_write(tmp_path):
    async with daemon(tmp_path) as (http, app):
        wid = await workspace(http)
        url = f"/v1/workspaces/{wid}/rpc"
        capacity = app.state.registry.get(wid).runner.ws.io.buffer_bytes
        running = asyncio.create_task(
            http.post(
                url,
                json=request(
                    7, "shell", {"command": "sleep 30", "open_stdin": True}
                ),
            )
        )
        data = base64.b64encode(b"x" * capacity).decode()
        written: dict = {}
        try:
            for _ in range(500):
                reply = await http.post(
                    url,
                    json=request(8, "stdin/write", {"id": 7, "data": data}),
                )
                written = reply.json()
                if written.get("error", {}).get("code") != -32004:
                    break
                await asyncio.sleep(0.01)
            assert written["result"] is None
            held = asyncio.create_task(
                http.post(
                    url,
                    json=request(
                        9,
                        "stdin/write",
                        {"id": 7, "data": base64.b64encode(b"y").decode()},
                    ),
                )
            )
            await asyncio.sleep(0.2)
            assert not held.done()
            assert (await http.delete(f"/v1/workspaces/{wid}")).is_success
            answer = (await asyncio.wait_for(held, 5)).json()
            assert answer["error"]["message"] == "stdin is closed"
        finally:
            running.cancel()


@pytest.mark.asyncio
async def test_open_stdin_takes_writes_on_other_requests(tmp_path):
    async with daemon(tmp_path) as (http, app):
        wid = await workspace(http)
        url = f"/v1/workspaces/{wid}/rpc"
        running = asyncio.create_task(
            http.post(
                url,
                json=request(
                    7, "shell", {"command": "cat", "open_stdin": True}
                ),
            )
        )
        data = base64.b64encode(b"one\n").decode()
        written: dict = {}
        try:
            for _ in range(500):
                reply = await http.post(
                    url,
                    json=request(8, "stdin/write", {"id": 7, "data": data}),
                )
                written = reply.json()
                if written.get("error", {}).get("code") != -32004:
                    break
                await asyncio.sleep(0.01)
            assert written["result"] is None
            closed = await http.post(
                url, json=request(9, "stdin/close", {"id": 7})
            )
            assert closed.json()["result"] is None
            assert (await running).json()["result"]["stdout"] == "one\n"
        finally:
            running.cancel()
