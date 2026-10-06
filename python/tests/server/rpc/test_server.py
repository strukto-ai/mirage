import asyncio
import base64
import json

import pytest

from mirage import MountMode, Workspace
from mirage.server.rpc.server import MirageRpcServer
from mirage.vfs.ram import RAMVFS


def server() -> MirageRpcServer:
    return MirageRpcServer(Workspace({"/": RAMVFS()}, mode=MountMode.WRITE))


async def call(rpc: MirageRpcServer, method: str, params: dict) -> dict:
    response = await rpc.handle(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    )
    assert response is not None
    return response


def b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


@pytest.mark.asyncio
async def test_initialize_names_the_session_and_the_methods():
    rpc = server()
    result = (await call(rpc, "initialize", {}))["result"]
    assert result["protocol_version"] == "1"
    assert result["session_id"] == rpc.session_id
    assert "shell" in result["methods"]
    assert "vfs/read" in result["methods"]


@pytest.mark.asyncio
async def test_shell_answers_like_session_shell():
    rpc = server()
    result = (await call(rpc, "shell", {"command": "echo hi; echo err >&2"}))[
        "result"
    ]
    assert result["exit_code"] == 0
    assert result["stdout"] == "hi\n"
    assert result["stderr"] == "err\n"
    stdin = await call(
        rpc, "shell", {"command": "wc -c", "stdin_base64": b64("abc")}
    )
    assert stdin["result"]["stdout"].strip() == "3"


@pytest.mark.asyncio
async def test_vfs_methods_mirror_the_ops():
    rpc = server()
    assert (await call(rpc, "vfs/mkdir", {"path": "/d"}))["result"] == {}
    await call(
        rpc, "vfs/write", {"path": "/d/a.txt", "data_base64": b64("one\n")}
    )
    await call(
        rpc, "vfs/append", {"path": "/d/a.txt", "data_base64": b64("two\n")}
    )
    read = (await call(rpc, "vfs/read", {"path": "/d/a.txt"}))["result"]
    assert base64.b64decode(read["data_base64"]) == b"one\ntwo\n"
    sliced = await call(
        rpc, "vfs/read", {"path": "/d/a.txt", "offset": 4, "size": 3}
    )
    assert base64.b64decode(sliced["result"]["data_base64"]) == b"two"
    stat = (await call(rpc, "vfs/stat", {"path": "/d/a.txt"}))["result"]
    assert stat["type"] == "file"
    assert stat["size"] == 8
    listed = (await call(rpc, "vfs/readdir", {"path": "/d"}))["result"]
    assert [name.rsplit("/", 1)[-1] for name in listed["entries"]] == ["a.txt"]
    await call(rpc, "vfs/rename", {"src": "/d/a.txt", "dst": "/d/b.txt"})
    await call(rpc, "vfs/truncate", {"path": "/d/b.txt", "length": 3})
    assert (await call(rpc, "vfs/exists", {"path": "/d/b.txt"}))["result"] == {
        "exists": True
    }
    globbed = (await call(rpc, "glob", {"pattern": "/d/*.txt"}))["result"]
    assert globbed == {"paths": ["/d/b.txt"]}
    await call(rpc, "vfs/unlink", {"path": "/d/b.txt"})
    await call(rpc, "vfs/rmdir", {"path": "/d"})
    assert (await call(rpc, "vfs/exists", {"path": "/d"}))["result"] == {
        "exists": False
    }


@pytest.mark.asyncio
async def test_explain_methods_are_the_dry_runs_of_their_doors():
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    ws.create_session(
        "agent",
        profile={
            "commands": {"deny": [{"reason": "sealed", "paths": ["/sec/*"]}]}
        },
    )
    rpc = MirageRpcServer(ws, "agent")
    assert "explain/vfs/rename" in rpc.methods
    shell = await call(rpc, "explain/shell", {"command": "rm /sec/k"})
    said = shell["result"]
    [rm] = said["node"]["children"]
    assert (rm["command"], said["outcome"], said["exit_code"]) == (
        "rm",
        "deny",
        1,
    )
    assert rm["answers"] == [
        {"kind": "deny", "reason": "sealed", "policy": "PermissionsPolicy"}
    ]
    assert (said["line"], said["source"]) == ("rm /sec/k", "top")
    written = await call(
        rpc, "explain/vfs/write", {"path": "/sec/k", "data_base64": b64("x")}
    )
    assert written["result"]["call"] == "write"
    assert written["result"]["paths"] == ["/sec/k"]
    assert (written["result"]["outcome"], written["result"]["error"]) == (
        "deny",
        "EACCES",
    )
    free = await call(
        rpc, "explain/vfs/write", {"path": "/f", "data_base64": ""}
    )
    assert (free["result"]["outcome"], free["result"]["error"]) == (
        "allow",
        "",
    )
    assert (await call(rpc, "vfs/exists", {"path": "/f"}))["result"] == {
        "exists": False
    }
    bad = await call(rpc, "explain/vfs/truncate", {"path": "/f"})
    assert bad["error"]["message"] == "length must be an integer"


@pytest.mark.asyncio
async def test_tools_are_the_mcp_tools():
    rpc = server()
    tools = (await call(rpc, "tools/list", {}))["result"]["tools"]
    assert [t["name"] for t in tools] == [
        "shell",
        "read",
        "write",
        "edit",
        "ls",
        "grep",
        "glob",
    ]
    written = await call(
        rpc,
        "tools/call",
        {"name": "write", "arguments": {"path": "/n.txt", "content": "x\n"}},
    )
    assert written["result"] == {"text": "Written: /n.txt", "is_error": False}
    bad = await call(rpc, "tools/call", {"name": "read", "arguments": {}})
    assert bad["error"]["code"] == -32602


@pytest.mark.asyncio
async def test_errors_carry_codes_and_the_errno():
    rpc = server()
    missing = await call(rpc, "vfs/read", {"path": "/nope"})
    assert missing["error"]["code"] == -32004
    assert missing["error"]["data"]["errno"] == "ENOENT"
    unknown = await call(rpc, "nope", {})
    assert unknown["error"]["code"] == -32601
    typed = await call(rpc, "vfs/read", {"path": 3})
    assert typed["error"]["code"] == -32602
    assert await rpc.handle({"jsonrpc": "2.0", "method": "shell"}) is None


@pytest.mark.asyncio
async def test_a_message_without_jsonrpc_2_0_runs_nothing():
    rpc = server()
    await call(
        rpc, "vfs/write", {"path": "/keep.txt", "data_base64": b64("x")}
    )
    refused = await rpc.handle(
        {"id": 2, "method": "vfs/unlink", "params": {"path": "/keep.txt"}}
    )
    assert refused is not None
    assert refused["error"]["code"] == -32600
    kept = await call(rpc, "vfs/exists", {"path": "/keep.txt"})
    assert kept["result"] == {"exists": True}


@pytest.mark.asyncio
async def test_serve_answers_lines_and_cancels_a_running_request():
    rpc = server()
    lines: asyncio.Queue[str] = asyncio.Queue()
    out: list[dict] = []

    async def write_line(text: str) -> None:
        out.append(json.loads(text))

    serving = asyncio.create_task(rpc.serve(lines.get, write_line))
    await lines.put(
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "shell",
                "params": {"command": "sleep 20"},
            }
        )
        + "\n"
    )
    await lines.put(
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "shell",
                "params": {"command": "echo fast"},
            }
        )
        + "\n"
    )
    await asyncio.sleep(0.3)
    await lines.put(
        json.dumps(
            {
                "jsonrpc": "2.0",
                "method": "$/cancelRequest",
                "params": {"id": 1},
            }
        )
        + "\n"
    )
    await lines.put("not json\n")
    await lines.put("")
    await asyncio.wait_for(serving, 5)
    by_id = {message.get("id"): message for message in out}
    assert by_id[1]["error"]["code"] == -32800
    assert by_id[None]["error"]["code"] == -32700
    assert 2 in by_id
