import pytest
import typer.main
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
    assert "--stale-write-protection" in opts
    assert "--no-stale-write-protection" in opts


def test_missing_config_exits_two(tmp_path, monkeypatch):
    empty = (tmp_path / "empty").resolve()
    empty.mkdir()
    monkeypatch.chdir(empty)
    for name in MCP_ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    result = runner.invoke(app, ["mcp"])
    assert result.exit_code == 2


def test_resolve_prefers_the_mcp_env_name(tree):
    found = resolve_mcp_config(cwd=tree,
                               env={
                                   "MIRAGE_MCP_CONFIG": "other.yaml",
                                   "MIRAGE_CONFIG": "workspace.yaml"
                               })
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
