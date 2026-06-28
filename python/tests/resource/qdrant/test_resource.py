from mirage.resource.qdrant import QdrantConfig, QdrantResource
from mirage.resource.registry import REGISTRY, build_resource


def _resource(**kw) -> QdrantResource:
    base = dict(collection="animals", group_by=["label"], id_field="id")
    base.update(kw)
    return QdrantResource(QdrantConfig(**base))


def test_resource_name_and_remote():
    res = _resource()
    assert res.name == "qdrant"
    assert res.is_remote is True
    assert res.SUPPORTS_SNAPSHOT is False


def test_resource_registers_ops():
    res = _resource()
    assert {"read", "readdir", "stat"} <= {o.name for o in res.ops_list()}


def test_resource_registers_commands():
    res = _resource()
    expected = {
        "cat", "find", "grep", "head", "ls", "rg", "search", "stat", "tail",
        "tree", "wc"
    }
    assert expected <= {c.name for c in res.commands()}


def test_resource_in_registry():
    assert "qdrant" in REGISTRY
    res = build_resource("qdrant", {"collection": "docs"})
    assert res.name == "qdrant"


def test_resource_get_state_redacts_api_key():
    res = _resource(api_key="secret-value")
    state = res.get_state()
    assert "secret-value" not in str(state)
