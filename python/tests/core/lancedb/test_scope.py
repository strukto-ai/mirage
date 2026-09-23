# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.core.hierarchy.scope import INVALID, ROOT, make_detect_scope
from mirage.core.lancedb.scope import (detect_for, filters_of, scopes_for,
                                       table_of)
from mirage.types import PathSpec
from mirage.vfs.lancedb.config import LanceDBConfig


def _cfg(**kw) -> LanceDBConfig:
    base = dict(uri="/tmp/db",
                group_by=["label", "kind"],
                id_column="id",
                title_column="name",
                blob_column="image_bytes",
                blob_ext="png",
                vector_column="vector")
    base.update(kw)
    return LanceDBConfig(**base)


def _ps(path: str) -> PathSpec:
    return PathSpec(virtual=path, directory=path, vfs_path=path.strip("/"))


def _detect(config: LanceDBConfig):
    return make_detect_scope(scopes_for(config))


def test_root_multi_table():
    match = _detect(_cfg())(_ps("/"))
    assert match.kind == ROOT


def test_table_group_dir():
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


def test_row_card():
    config = _cfg()
    match = _detect(config)(_ps("/animals/cat/big/3.md"))
    assert match.kind == "row_card"
    assert match.slots["row_id"] == "3"
    assert filters_of(config, match) == {"label": "cat", "kind": "big"}


def test_row_blob():
    match = _detect(_cfg())(_ps("/animals/cat/big/3.png"))
    assert match.kind == "row_blob"
    assert match.slots["row_id"] == "3"


def test_blob_needs_blob_column():
    match = _detect(_cfg(blob_column=None))(_ps("/animals/cat/big/3.png"))
    assert match.kind == INVALID


def test_too_deep_is_invalid():
    match = _detect(_cfg())(_ps("/animals/cat/big/3.md/extra"))
    assert match.kind == INVALID


def test_single_table_pin_elides_table():
    config = _cfg(table="animals")
    match = _detect(config)(_ps("/cat/big"))
    assert match.kind == "group"
    assert table_of(config, match) == "animals"
    assert filters_of(config, match) == {"label": "cat", "kind": "big"}


def test_pinned_flat_table_rows_at_root():
    config = _cfg(table="animals", group_by=[])
    detect = _detect(config)
    assert detect(_ps("/")).kind == ROOT
    match = detect(_ps("/3.md"))
    assert match.kind == "row_card"
    assert match.slots["row_id"] == "3"
    assert detect(_ps("/whatever")).kind == INVALID


def test_detect_for_caches_per_accessor():
    accessor = LanceDBAccessor(_cfg())
    assert detect_for(accessor) is detect_for(accessor)
    other = LanceDBAccessor(_cfg(group_by=["label"]))
    assert detect_for(other)(_ps("/animals/cat/3.md")).kind == "row_card"


def test_filters_decode_escaped_group_segments():
    # ``a/b`` lists as ``a∕b`` and ``a∕b`` as ``a⁄∕b``; the WHERE clause
    # each directory builds must hold the value it was rendered from.
    config = _cfg()
    detect = _detect(config)
    assert filters_of(config, detect(_ps("/animals/a∕b"))) == {"label": "a/b"}
    assert filters_of(config, detect(_ps("/animals/a⁄∕b"))) == {"label": "a∕b"}
    assert filters_of(config, detect(_ps("/animals/⁄"))) == {"label": ""}
    assert filters_of(config, detect(_ps("/animals/⁄.env"))) == {
        "label": ".env"
    }
