import pytest
from typer.testing import CliRunner

from mirage.cli.main import app
from mirage.cli.rpc import RPC_ENV_NAMES

MINIMAL = "mounts:\n  /:\n    vfs: ram\n    mode: WRITE\n"

runner = CliRunner()


@pytest.fixture
def tree(tmp_path):
    root = tmp_path.resolve()
    (root / "workspace.yaml").write_text(MINIMAL)
    return root


def test_rpc_is_registered():
    result = runner.invoke(app, ["--help"])
    assert result.exit_code == 0
    assert "rpc" in result.stdout


@pytest.mark.parametrize("flag", ["-w", "--workspace", "--workspace_id"])
def test_a_config_and_a_workspace_are_exclusive(tree, flag):
    result = runner.invoke(
        app, ["rpc", str(tree / "workspace.yaml"), flag, "ws_1"]
    )
    assert result.exit_code == 2
    assert "pass a config or --workspace, not both" in result.stderr


def test_env_names_are_rpc_then_shared():
    assert RPC_ENV_NAMES == ("MIRAGE_RPC_CONFIG", "MIRAGE_CONFIG")
