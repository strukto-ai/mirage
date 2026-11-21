import shutil
import sys
from pathlib import Path

import pytest
from typer.testing import CliRunner

from mirage.cli.acp import mcp_server, workspace_of
from mirage.cli.main import app
from mirage.cli.mcp import MCP_ENV_NAMES

MINIMAL = "mounts:\n  /:\n    vfs: ram\n    mode: WRITE\n"

runner = CliRunner()


def test_acp_is_registered():
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    assert "acp" in result.stdout


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("http://127.0.0.1:8765/v1/workspaces/demo/rpc", "demo"),
        ("https://h.example/base/v1/workspaces/a%2Fb/rpc?session_id=s", "a/b"),
    ],
)
def test_workspace_of(url, expected):
    assert workspace_of(url) == expected


def test_mcp_server_runs_mirage_mcp_on_the_same_session():
    server = mcp_server("demo", "agent")
    script = shutil.which("mirage", path=str(Path(sys.executable).parent))
    assert script is not None
    assert server == {
        "name": "mirage",
        "command": script,
        "args": ["mcp", "--workspace", "demo", "--session", "agent"],
        "env": [],
    }
    assert "--session" not in mcp_server("demo", None)["args"]


def test_mcp_server_falls_back_to_the_cli_module(monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "executable", str(tmp_path / "python"))
    server = mcp_server("demo", None)
    assert (server["command"], server["args"][:2]) == (
        str(tmp_path / "python"),
        ["-m", "mirage.cli.main"],
    )


def test_a_config_and_a_workspace_are_exclusive(tmp_path):
    config = tmp_path / "workspace.yaml"
    config.write_text(MINIMAL)
    result = runner.invoke(
        app, ["acp", "-c", str(config), "-w", "ws_1", "--", "agent"]
    )
    assert result.exit_code == 2
    assert "pass --config or --workspace, not both" in result.stderr


def test_root_must_be_absolute():
    result = runner.invoke(app, ["acp", "-w", "ws_1", "--root", "p", "agent"])
    assert result.exit_code == 2
    assert "--root takes an absolute workspace path" in result.stderr


def test_missing_config_exits_two(tmp_path, monkeypatch):
    empty = (tmp_path / "empty").resolve()
    empty.mkdir()
    monkeypatch.chdir(empty)
    for name in MCP_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    result = runner.invoke(app, ["acp", "agent"])
    assert result.exit_code == 2


def test_an_agent_needs_a_command():
    result = runner.invoke(app, ["acp", "-w", "ws_1"])
    assert result.exit_code == 2
