import pytest

from mirage.server.workspace_config import (WORKSPACE_CONFIG_CANDIDATES,
                                            build_workspace_from_config,
                                            resolve_workspace_config)

MINIMAL = "mounts:\n  /:\n    resource: ram\n    mode: WRITE\n"


@pytest.fixture
def tree(tmp_path):
    root = tmp_path.resolve()
    (root / ".mirage").mkdir()
    (root / ".mirage" / "workspace.yaml").write_text(MINIMAL)
    (root / "other.yaml").write_text(MINIMAL)
    return root


def test_explicit_path_wins(tree):
    assert resolve_workspace_config("other.yaml",
                                    cwd=tree).name == "other.yaml"


def test_explicit_missing_path_raises(tree):
    with pytest.raises(FileNotFoundError, match="config not found"):
        resolve_workspace_config("nope.yaml", cwd=tree)


def test_env_name_is_consulted(tree):
    found = resolve_workspace_config(cwd=tree,
                                     env={"MIRAGE_CONFIG": "other.yaml"})
    assert found.name == "other.yaml"


def test_env_names_are_tried_in_order(tree):
    found = resolve_workspace_config(cwd=tree,
                                     env={"MIRAGE_CONFIG": "other.yaml"},
                                     env_names=("MIRAGE_MCP_CONFIG",
                                                "MIRAGE_CONFIG"))
    assert found.name == "other.yaml"


def test_explicit_path_beats_env(tree):
    (tree / "explicit.yaml").write_text(MINIMAL)
    found = resolve_workspace_config("explicit.yaml",
                                     cwd=tree,
                                     env={"MIRAGE_CONFIG": "other.yaml"})
    assert found.name == "explicit.yaml"


def test_walks_up_from_a_subdirectory(tree):
    deep = tree / "a" / "b" / "c"
    deep.mkdir(parents=True)
    found = resolve_workspace_config(cwd=deep, env={})
    assert found == tree / ".mirage" / "workspace.yaml"


def test_candidate_order_prefers_dot_mirage(tmp_path):
    root = tmp_path.resolve()
    (root / ".mirage").mkdir()
    (root / ".mirage" / "workspace.yaml").write_text(MINIMAL)
    (root / "mirage.yaml").write_text(MINIMAL)
    found = resolve_workspace_config(cwd=root, env={})
    assert found.parent.name == ".mirage"


def test_every_candidate_is_found(tmp_path):
    for candidate in WORKSPACE_CONFIG_CANDIDATES:
        root = (tmp_path / candidate.replace("/", "_")).resolve()
        target = root / candidate
        target.parent.mkdir(parents=True)
        target.write_text(MINIMAL)
        assert resolve_workspace_config(cwd=root, env={}) == target


def test_no_config_anywhere_raises(tmp_path):
    with pytest.raises(FileNotFoundError, match="No Mirage workspace config"):
        resolve_workspace_config(cwd=(tmp_path / "empty").resolve(), env={})


def test_missing_config_message_names_the_env_vars(tmp_path):
    empty = (tmp_path / "empty2").resolve()
    empty.mkdir()
    with pytest.raises(FileNotFoundError, match="MIRAGE_MCP_CONFIG or"):
        resolve_workspace_config(cwd=empty,
                                 env={},
                                 env_names=("MIRAGE_MCP_CONFIG",
                                            "MIRAGE_CONFIG"))


@pytest.mark.asyncio
async def test_build_workspace_from_config(tree):
    ws = await build_workspace_from_config(tree / "other.yaml")
    try:
        await ws.fs.write("/a.txt", b"hi")
        assert await ws.fs.read("/a.txt") == b"hi"
        assert ws.workspace_id
    finally:
        await ws.close()
