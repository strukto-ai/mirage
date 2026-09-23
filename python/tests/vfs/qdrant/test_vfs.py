import pytest

from mirage.vfs.qdrant import QdrantConfig, QdrantVFS
from mirage.vfs.registry import REGISTRY, build_vfs


def _vfs(**kw) -> QdrantVFS:
    base = dict(collection="animals", group_by=["label"], id_field="id")
    base.update(kw)
    return QdrantVFS(QdrantConfig(**base))


def test_vfs_name_and_snapshot():
    res = _vfs()
    assert res.name == "qdrant"
    assert res.SUPPORTS_SNAPSHOT is False


def test_vfs_registers_ops():
    res = _vfs()
    assert {"read", "readdir", "stat"} <= {o.name for o in res.ops_list()}


def test_vfs_registers_commands():
    res = _vfs()
    expected = {
        "cat", "find", "grep", "head", "ls", "rg", "search", "stat", "tail",
        "tree", "wc"
    }
    assert expected <= {c.name for c in res.commands()}


@pytest.mark.asyncio
async def test_vfs_in_registry():
    assert "qdrant" in REGISTRY
    res = build_vfs("qdrant", {"collection": "docs"})
    assert res.name == "qdrant"


def test_vfs_get_state_redacts_api_key():
    res = _vfs(api_key="secret-value")
    state = res.get_state()
    assert "secret-value" not in str(state)
