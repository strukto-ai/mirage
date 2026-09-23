from mirage.accessor.qdrant import QdrantAccessor
from mirage.core.hierarchy.scope import INVALID, ROOT, make_detect_scope
from mirage.core.qdrant.scope import (detect_for, filters_of, scopes_for,
                                      table_of)
from mirage.types import PathSpec
from mirage.vfs.qdrant.config import QdrantConfig


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
    return PathSpec(virtual=path, directory=path, vfs_path=path.strip("/"))


def _detect(config: QdrantConfig):
    return make_detect_scope(scopes_for(config))


def test_root_multi_collection():
    match = _detect(_cfg())(_ps("/"))
    assert match.kind == ROOT


def test_collection_group_dir():
    config = _cfg()
    match = _detect(config)(_ps("/animals"))
    assert match.kind == "group"
    assert table_of(config, match) == "animals"
    assert filters_of(config, match) == {}


def test_nested_group_dir():
    config = _cfg()
    match = _detect(config)(_ps("/animals/cat"))
    assert match.kind == "group"
    assert filters_of(config, match) == {"label": "cat"}


def test_leaf_group_dir():
    config = _cfg()
    match = _detect(config)(_ps("/animals/cat/big"))
    assert match.kind == "group"
    assert filters_of(config, match) == {"label": "cat", "kind": "big"}


def test_row_json():
    config = _cfg()
    match = _detect(config)(_ps("/animals/cat/big/3.json"))
    assert match.kind == "row_json"
    assert match.slots["row_id"] == "3"
    assert filters_of(config, match) == {"label": "cat", "kind": "big"}


def test_row_text():
    match = _detect(_cfg())(_ps("/animals/cat/big/3.txt"))
    assert match.kind == "row_text"
    assert match.slots["row_id"] == "3"


def test_row_blob():
    match = _detect(_cfg())(_ps("/animals/cat/big/3.png"))
    assert match.kind == "row_blob"
    assert match.slots["row_id"] == "3"


def test_text_needs_text_field():
    match = _detect(_cfg(text_field=None))(_ps("/animals/cat/big/3.txt"))
    assert match.kind == INVALID


def test_blob_needs_blob_field():
    match = _detect(_cfg(blob_field=None))(_ps("/animals/cat/big/3.png"))
    assert match.kind == INVALID


def test_too_deep_is_invalid():
    match = _detect(_cfg())(_ps("/animals/cat/big/3.json/extra"))
    assert match.kind == INVALID


def test_single_collection_pin_elides_collection():
    config = _cfg(collection="animals")
    match = _detect(config)(_ps("/cat/big"))
    assert match.kind == "group"
    assert table_of(config, match) == "animals"
    assert filters_of(config, match) == {"label": "cat", "kind": "big"}


def test_filters_decode_escaped_group_segments():
    config = _cfg(collection="animals", group_by=["label"])
    detect = _detect(config)
    assert filters_of(config, detect(_ps("/a∕b"))) == {"label": "a/b"}
    assert filters_of(config, detect(_ps("/a⁄∕b"))) == {"label": "a∕b"}
    assert filters_of(config, detect(_ps("/⁄"))) == {"label": ""}
    assert filters_of(config, detect(_ps("/⁄.env"))) == {"label": ".env"}


def test_detect_for_caches_per_accessor():
    accessor = QdrantAccessor(_cfg())
    assert detect_for(accessor) is detect_for(accessor)
    other = QdrantAccessor(_cfg(collection="animals", group_by=["label"]))
    assert detect_for(other)(_ps("/cat/3.json")).kind == "row_json"
