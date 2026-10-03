import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest
import typer.main
from mcp import Client, StdioServerParameters
from typer.testing import CliRunner

from mirage.cli.main import app
from mirage.cli.mcp import MCP_ENV_NAMES, resolve_mcp_config

MINIMAL = "mounts:\n  /:\n    vfs: ram\n    mode: WRITE\n"

runner = CliRunner()


@pytest.fixture
def tree(tmp_path):
    root = tmp_path.resolve()
    (root / "workspace.yaml").write_text(MINIMAL)
    (root / "other.yaml").write_text(MINIMAL)
    return root


def test_mcp_is_registered():
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    assert "mcp" in result.stdout


def test_mcp_help_describes_stdio():
    # Asserted on the declarations rather than the rendered help: the
    # help box is laid out to the terminal's width, so an assertion
    # against its text passes or fails on how wide the runner's terminal
    # happens to be -- CI's is narrower than a local one, and the flag
    # pair wrapped away there after passing here.
    mcp = typer.main.get_command(app).commands["mcp"]
    assert "stdio" in (mcp.help or "")
    opts = {
        opt
        for param in mcp.params
        for opt in (*param.opts, *param.secondary_opts)
    }
    assert {"--workspace", "-w", "--session", "-s"} <= opts


def test_missing_config_exits_two(tmp_path, monkeypatch):
    empty = (tmp_path / "empty").resolve()
    empty.mkdir()
    monkeypatch.chdir(empty)
    for name in MCP_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    result = runner.invoke(app, ["mcp"])
    assert result.exit_code == 2


def test_a_config_and_a_workspace_are_exclusive(tree):
    result = runner.invoke(
        app, ["mcp", str(tree / "workspace.yaml"), "-w", "ws_1"]
    )
    assert result.exit_code == 2
    assert "pass a config or --workspace, not both" in result.stderr


def test_resolve_prefers_the_mcp_env_name(tree):
    found = resolve_mcp_config(
        cwd=tree,
        env={
            "MIRAGE_MCP_CONFIG": "other.yaml",
            "MIRAGE_CONFIG": "workspace.yaml",
        },
    )
    assert found.name == "other.yaml"


def test_resolve_falls_back_to_the_shared_env_name(tree):
    found = resolve_mcp_config(cwd=tree, env={"MIRAGE_CONFIG": "other.yaml"})
    assert found.name == "other.yaml"


def test_resolve_discovers_by_walking_up(tree):
    deep = tree / "a" / "b"
    deep.mkdir(parents=True)
    assert resolve_mcp_config(cwd=deep, env={}) == tree / "workspace.yaml"


def test_env_names_are_mcp_then_shared():
    assert MCP_ENV_NAMES == ("MIRAGE_MCP_CONFIG", "MIRAGE_CONFIG")


def relay(daemon, *args: str) -> StdioServerParameters:
    return StdioServerParameters(
        command=sys.executable,
        args=["-m", "mirage.cli.main", "mcp", *args],
        env=daemon["env"],
    )


@pytest.mark.asyncio
async def test_relays_the_daemons_tools_over_stdio(daemon, tree):
    async with Client(relay(daemon, str(tree / "workspace.yaml"))) as client:
        tools = sorted(t.name for t in (await client.list_tools()).tools)
        await client.call_tool("write", {"path": "/a.txt", "content": "hi\n"})
        read = await client.call_tool("read", {"path": "/a.txt"})
        ran = await client.call_tool("shell", {"command": "wc -l /a.txt"})
        listed = httpx.get(f"{daemon['url']}/v1/workspaces").json()
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
    assert read.content[0].text == "     1\thi\n"
    assert ran.content[0].text == "1 /a.txt\n"
    assert len(listed) == 1


@pytest.mark.asyncio
async def test_a_loaded_workspace_goes_with_the_process(daemon, tree):
    async with Client(relay(daemon, str(tree / "workspace.yaml"))) as client:
        await client.call_tool("shell", {"command": "true"})
    assert httpx.get(f"{daemon['url']}/v1/workspaces").json() == []


@pytest.mark.asyncio
async def test_a_named_workspace_stays(daemon, tree):
    created = httpx.post(
        f"{daemon['url']}/v1/workspaces",
        json={"config": {"mounts": {"/": {"vfs": "ram", "mode": "WRITE"}}}},
    ).json()
    async with Client(relay(daemon, "-w", created["id"])) as client:
        await client.call_tool("write", {"path": "/kept.txt", "content": "x"})
    ran = httpx.post(
        f"{daemon['url']}/v1/workspaces/{created['id']}/shell",
        json={"command": "cat /kept.txt"},
    ).json()
    assert ran["stdout"] == "x"


@pytest.mark.asyncio
async def test_a_named_workspace_stays_and_is_attached_again(daemon, tmp_path):
    named = tmp_path / "named.yaml"
    named.write_text(
        "workspace_id: demo?draft\nmounts:\n  /:\n    vfs: ram\n    mode: WRITE\n"
    )
    async with Client(relay(daemon, str(named))) as client:
        await client.call_tool("write", {"path": "/kept.txt", "content": "x"})
    async with Client(relay(daemon, str(named))) as client:
        read = await client.call_tool("read", {"path": "/kept.txt"})
    listed = httpx.get(f"{daemon['url']}/v1/workspaces").json()
    assert read.content[0].text == "     1\tx"
    assert [w["id"] for w in listed] == ["demo?draft"]


def test_a_name_held_by_another_config_is_refused(daemon, tmp_path):
    httpx.post(
        f"{daemon['url']}/v1/workspaces",
        json={
            "config": {
                "workspace_id": "shared",
                "mounts": {"/": {"vfs": "ram", "mode": "WRITE"}},
            }
        },
    ).raise_for_status()
    other = tmp_path / "other.yaml"
    other.write_text(
        "workspace_id: shared\nmounts:\n  /:\n    vfs: ram\n    mode: READ\n"
    )
    params = relay(daemon, str(other))
    refused = subprocess.run(
        [params.command, *params.args],
        env=daemon["env"],
        input=b"",
        capture_output=True,
        timeout=60,
    )
    assert refused.returncode == 2
    assert b"workspace id already exists" in refused.stderr


def _guarded(daemon) -> str:
    created = httpx.post(
        f"{daemon['url']}/v1/workspaces",
        json={
            "config": {
                "mounts": {
                    "/": {"vfs": "ram", "mode": "WRITE"},
                    "/vault": {"vfs": "ram", "mode": "WRITE"},
                },
                "profiles": {"guarded": {"paths": {"hide": ["/vault"]}}},
            }
        },
    ).json()
    wid = created["id"]
    httpx.post(
        f"{daemon['url']}/v1/workspaces/{wid}/shell",
        json={"command": "echo key > /vault/key.txt"},
    ).raise_for_status()
    httpx.post(
        f"{daemon['url']}/v1/workspaces/{wid}/sessions",
        json={"session_id": "agent", "profile": "guarded"},
    ).raise_for_status()
    return wid


@pytest.mark.asyncio
async def test_a_session_serves_the_tools_under_its_profile(daemon):
    wid = _guarded(daemon)
    async with Client(relay(daemon, "-w", wid, "-s", "agent")) as client:
        read = await client.call_tool("read", {"path": "/vault/key.txt"})
        ran = await client.call_tool("shell", {"command": "pwd; ls /"})
    async with Client(relay(daemon, "-w", wid)) as client:
        default = await client.call_tool("read", {"path": "/vault/key.txt"})
    assert read.content[0].text == "Error: file '/vault/key.txt' not found"
    assert "vault" not in ran.content[0].text
    assert default.content[0].text == "     1\tkey\n"


def test_an_unknown_session_is_refused(daemon, tree):
    params = relay(daemon, str(tree / "workspace.yaml"), "-s", "nope")
    refused = subprocess.run(
        [params.command, *params.args],
        env=daemon["env"],
        input=b"",
        capture_output=True,
        timeout=60,
    )
    listed = httpx.get(f"{daemon['url']}/v1/workspaces").json()
    assert refused.returncode == 2
    assert b"session not found: nope\n" in refused.stderr
    assert listed == []


def test_a_refused_session_check_deletes_the_workspace(tree, tmp_path):
    calls: list[str] = []

    class RefusingDaemon(BaseHTTPRequestHandler):
        def answer(self) -> None:
            calls.append(f"{self.command} {self.path}")
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            refused = self.path.endswith("/sessions")
            status = 500 if refused else 201 if self.command == "POST" else 200
            body = (
                {"detail": "sessions on fire"} if refused else {"id": "minted"}
            )
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = do_POST = do_DELETE = answer

        def log_message(self, format: str, *args: str) -> None:
            pass

    stub = ThreadingHTTPServer(("127.0.0.1", 0), RefusingDaemon)
    threading.Thread(target=stub.serve_forever, daemon=True).start()
    try:
        result = runner.invoke(
            app,
            ["mcp", str(tree / "workspace.yaml"), "-s", "agent"],
            env={
                "MIRAGE_DAEMON_URL": f"http://127.0.0.1:{stub.server_port}",
                "MIRAGE_HOME": str(tmp_path),
            },
        )
    finally:
        stub.shutdown()
        stub.server_close()
    assert result.exit_code == 2
    assert "daemon error 500: sessions on fire" in result.output
    assert "DELETE /v1/workspaces/minted" in calls
