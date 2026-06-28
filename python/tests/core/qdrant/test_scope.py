from mirage.core.qdrant.scope import ScopeLevel, detect_scope
from mirage.resource.qdrant.config import QdrantConfig
from mirage.types import PathSpec


def _cfg(**kw) -> QdrantConfig:
    base = dict(group_by=["label", "kind"],
                id_field="id",
                text_field="name",
                blob_field="image_bytes",
                blob_ext="png",
                vector_field="vector")
    base.update(kw)
    return QdrantConfig(**base)


def _ps(path: str) -> PathSpec:
    return PathSpec(original=path, directory=path)


def test_root_multi_collection():
    s = detect_scope(_ps("/"), _cfg())
    assert s.level == ScopeLevel.ROOT


def test_collection_group_dir():
    s = detect_scope(_ps("/animals"), _cfg())
    assert s.level == ScopeLevel.GROUP_DIR
    assert s.table == "animals"
    assert s.filters == {}


def test_nested_group_dir():
    s = detect_scope(_ps("/animals/cat"), _cfg())
    assert s.level == ScopeLevel.GROUP_DIR
    assert s.filters == {"label": "cat"}


def test_leaf_group_dir():
    s = detect_scope(_ps("/animals/cat/big"), _cfg())
    assert s.level == ScopeLevel.GROUP_DIR
    assert s.filters == {"label": "cat", "kind": "big"}


def test_row_json():
    s = detect_scope(_ps("/animals/cat/big/3.json"), _cfg())
    assert s.level == ScopeLevel.ROW
    assert s.row_id == "3"
    assert s.kind == "json"
    assert s.filters == {"label": "cat", "kind": "big"}


def test_row_text():
    s = detect_scope(_ps("/animals/cat/big/3.txt"), _cfg())
    assert s.level == ScopeLevel.ROW
    assert s.row_id == "3"
    assert s.kind == "txt"


def test_row_blob():
    s = detect_scope(_ps("/animals/cat/big/3.png"), _cfg())
    assert s.level == ScopeLevel.ROW
    assert s.row_id == "3"
    assert s.kind == "blob"


def test_single_collection_pin_elides_collection():
    s = detect_scope(_ps("/cat/big"), _cfg(collection="animals"))
    assert s.level == ScopeLevel.GROUP_DIR
    assert s.table == "animals"
    assert s.filters == {"label": "cat", "kind": "big"}
