import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
import typer.main
from typer.testing import CliRunner

from mirage.cli.credentials import Login, remove_login, write_login
from mirage.cli.main import app
from mirage.cli.mcp import MCP_ENV_NAMES, relay_workspace, resolve_mcp_config

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


@pytest.mark.parametrize("flag", ["-w", "--workspace", "--workspace_id"])
def test_a_config_and_a_workspace_are_exclusive(tree, flag):
    result = runner.invoke(
        app, ["mcp", str(tree / "workspace.yaml"), flag, "ws_1"]
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


def test_a_relay_that_outlives_its_login_still_deletes_its_workspace(
    tree, tmp_path, monkeypatch
):
    calls: list[str] = []

    class Daemon(BaseHTTPRequestHandler):
        def answer(self) -> None:
            sent = self.headers.get("Authorization", "")
            calls.append(f"{self.command} {self.path} {sent}")
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            status = 201 if self.command == "POST" else 200
            data = json.dumps({"id": "minted"}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = do_POST = do_DELETE = answer

        def log_message(self, format: str, *args: str) -> None:
            pass

    stub = ThreadingHTTPServer(("127.0.0.1", 0), Daemon)
    threading.Thread(target=stub.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{stub.server_port}"
    monkeypatch.setenv("MIRAGE_HOME", str(tmp_path))
    monkeypatch.setenv("MIRAGE_DAEMON_URL", url)
    monkeypatch.delenv("MIRAGE_TOKEN", raising=False)
    write_login(
        Login(url=url, access_token="from-login", logged_in_at=time.time())
    )

    async def relay(endpoint: str, token) -> None:
        assert token() == "from-login"
        remove_login()

    try:
        relay_workspace(tree / "workspace.yaml", None, None, "mcp", relay)
    finally:
        stub.shutdown()
        stub.server_close()
    assert "DELETE /v1/workspaces/minted Bearer from-login" in calls
