import asyncio
import base64
import json
import os
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
import uvicorn

from mirage.server import build_app
from mirage.server.acp import relay
from mirage.server.acp.errors import WorkspaceCallError
from mirage.types import JsonObject, JsonValue

CONFIG = {"config": {"mounts": {"/": {"vfs": "ram", "mode": "WRITE"}}}}

SERVER = {"name": "mirage", "command": "/bin/mirage", "args": [], "env": []}

AGENT = """
import json
import sys


def send(message):
    sys.stdout.write(json.dumps(message) + "\\n")
    sys.stdout.flush()


def receive():
    line = sys.stdin.readline()
    return json.loads(line) if line else None


folder = "/home/me/proj"
asks = [
    ("fs/read_text_file", {"path": folder + "/notes.txt", "line": 2, "limit": 1}),
    ("fs/write_text_file", {"path": folder + "/out.txt", "content": "written\\n"}),
    ("fs/read_text_file", {"path": folder + "/missing.txt"}),
    ("fs/read_text_file", {"path": "notes.txt"}),
]
while (message := receive()) is not None:
    method = message.get("method")
    if method == "initialize":
        result = {"protocolVersion": 1, "_meta": {"seen": message["params"]}}
    elif method == "session/new":
        result = {"sessionId": "s1", "_meta": {"seen": message["params"]}}
    elif method == "session/prompt":
        send({"jsonrpc": "2.0", "method": "session/update", "params": {"x": 1}})
        answers = []
        for n, (ask, params) in enumerate(asks):
            params = {"sessionId": "s1", **params}
            send({"jsonrpc": "2.0", "id": 100 + n, "method": ask, "params": params})
            answers.append(receive())
        result = {"stopReason": "end_turn", "_meta": {"answers": answers}}
    else:
        continue
    send({"jsonrpc": "2.0", "id": message["id"], "result": result})
sys.exit(int(sys.argv[1]) if len(sys.argv) > 1 else 0)
"""


@asynccontextmanager
async def daemon(tmp_path: Path) -> AsyncIterator[str]:
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
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        await task


class Lines:
    def __init__(self, until: int) -> None:
        self.text = ""
        self.until = until
        self.done = asyncio.Event()

    def write(self, text: str) -> None:
        self.text += text
        for line in text.splitlines():
            if json.loads(line).get("id") == self.until:
                self.done.set()

    def flush(self) -> None:
        pass

    def messages(self) -> list[JsonObject]:
        return [json.loads(line) for line in self.text.splitlines()]


def agent(tmp_path: Path, *args: str) -> list[str]:
    script = tmp_path / "agent.py"
    script.write_text(AGENT)
    return [sys.executable, str(script), *args]


async def nothing() -> AsyncIterator[str]:
    for line in ():
        yield line


async def no_call(method: str, params: JsonObject) -> JsonValue:
    raise WorkspaceCallError(-32603, f"unexpected {method}")


def test_with_files_offers_both_file_methods():
    params = {"clientCapabilities": {"terminal": True, "fs": {}}}
    assert relay.with_files(params)["clientCapabilities"] == {
        "terminal": True,
        "fs": {"readTextFile": True, "writeTextFile": True},
    }


def test_with_mirage_replaces_a_server_of_the_same_name():
    other = {"name": "docs", "command": "/bin/docs", "args": [], "env": []}
    stale = {**SERVER, "command": "/old/mirage"}
    params = relay.with_mirage(
        {"cwd": "/w", "mcpServers": [other, stale]}, SERVER
    )
    assert params["mcpServers"] == [other, SERVER]
    assert params["_meta"] == {"claudeCode": {"options": {"tools": []}}}


def test_with_mirage_keeps_tools_the_client_chose():
    meta = {"claudeCode": {"options": {"tools": ["Read"], "model": "m"}}}
    params = relay.with_mirage({"cwd": "/w", "_meta": meta}, SERVER)
    assert params["_meta"] == meta


@pytest.mark.parametrize(
    ("path", "cwd", "root", "expected"),
    [
        ("/home/me/proj/a.txt", "/home/me/proj", "/", "/a.txt"),
        (
            "/home/me/proj/a.txt",
            "/home/me/proj/",
            "/project",
            "/project/a.txt",
        ),
        ("/home/me/proj", "/home/me/proj", "/project", "/project"),
        (
            "/home/me/projx/a.txt",
            "/home/me/proj",
            "/project",
            "/home/me/projx/a.txt",
        ),
        ("/etc/hosts", None, "/project", "/etc/hosts"),
        ("/a.txt", "/", "/project", "/project/a.txt"),
    ],
)
def test_workspace_path(path, cwd, root, expected):
    assert relay.workspace_path(path, cwd, root) == expected


@pytest.mark.parametrize(
    ("line", "limit", "expected"),
    [
        (None, None, "one\ntwo\nthree"),
        (2, None, "two\nthree"),
        (2, 1, "two\n"),
        (None, 2, "one\ntwo\n"),
        (9, 1, ""),
    ],
)
def test_text_slice(line, limit, expected):
    assert relay.text_slice("one\ntwo\nthree", line, limit) == expected


@pytest.mark.asyncio
async def test_answers_the_agents_files_from_the_workspace(
    tmp_path, monkeypatch
):
    async with daemon(tmp_path) as base:
        async with httpx.AsyncClient(base_url=base) as http:
            wid = (await http.post("/v1/workspaces", json=CONFIG)).json()["id"]
            url = f"{base}/v1/workspaces/{wid}/rpc"
            notes = base64.b64encode(b"one\ntwo\nthree\n").decode()
            await http.post(
                url,
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "vfs/write",
                    "params": {"path": "/notes.txt", "data": notes},
                },
            )
            read, write = os.pipe()
            stdin = os.fdopen(read, "r")
            client = os.fdopen(write, "w")
            stdout = Lines(until=3)
            monkeypatch.setattr(relay.sys, "stdin", stdin)
            monkeypatch.setattr(relay.sys, "stdout", stdout)
            sent = [
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {"protocolVersion": 1, "clientCapabilities": {}},
                },
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "session/new",
                    "params": {"cwd": "/home/me/proj", "mcpServers": []},
                },
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "session/prompt",
                    "params": {"sessionId": "s1", "prompt": []},
                },
            ]
            client.write("".join(json.dumps(m) + "\n" for m in sent))
            client.flush()
            running = asyncio.create_task(
                relay.relay_stdio(
                    agent(tmp_path), url, lambda: "", SERVER, "/"
                )
            )
            await asyncio.wait_for(stdout.done.wait(), 30)
            client.close()
            assert await asyncio.wait_for(running, 30) == 0
            written = await http.post(
                url,
                json={
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "vfs/read",
                    "params": {"path": "/out.txt"},
                },
            )
    by_id = {m.get("id"): m for m in stdout.messages()}
    files = by_id[1]["result"]["_meta"]["seen"]["clientCapabilities"]["fs"]
    assert files == {"readTextFile": True, "writeTextFile": True}
    assert by_id[2]["result"]["_meta"]["seen"]["mcpServers"] == [SERVER]
    read_two, wrote, missing, relative = by_id[3]["result"]["_meta"]["answers"]
    assert read_two["result"] == {"content": "two\n"}
    assert wrote["result"] == {}
    assert missing["error"]["code"] == -32002
    assert relative["error"]["code"] == -32602
    assert base64.b64decode(written.json()["result"]["data"]) == b"written\n"
    methods = [m.get("method") for m in stdout.messages()]
    assert methods.count("session/update") == 1
    assert not {"fs/read_text_file", "fs/write_text_file"} & set(methods)


@pytest.mark.asyncio
async def test_exits_with_the_agents_status(tmp_path):
    written: list[str] = []

    async def write(line: str) -> None:
        written.append(line)

    status = await relay.relay_agent(
        agent(tmp_path, "3"), no_call, SERVER, "/", nothing(), write
    )
    assert (status, written) == (3, [])


@pytest.mark.asyncio
async def test_a_missing_agent_raises_file_not_found(tmp_path):
    async def write(line: str) -> None:
        raise AssertionError(line)

    with pytest.raises(FileNotFoundError):
        await relay.relay_agent(
            [str(tmp_path / "no-such-agent")],
            no_call,
            SERVER,
            "/",
            nothing(),
            write,
        )
