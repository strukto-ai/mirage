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

from mirage.core.lancedb.scope import ScopeLevel, detect_scope
from mirage.resource.lancedb.config import LanceDBConfig
from mirage.types import PathSpec


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
    return PathSpec(virtual=path,
                    directory=path,
                    resource_path=path.strip("/"))


def test_root_multi_table():
    s = detect_scope(_ps("/"), _cfg())
    assert s.level == ScopeLevel.ROOT


def test_table_group_dir():
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


def test_row_card():
    s = detect_scope(_ps("/animals/cat/big/3.md"), _cfg())
    assert s.level == ScopeLevel.ROW
    assert s.row_id == "3"
    assert s.blob is False
    assert s.filters == {"label": "cat", "kind": "big"}


def test_row_blob():
    s = detect_scope(_ps("/animals/cat/big/3.png"), _cfg())
    assert s.level == ScopeLevel.ROW
    assert s.row_id == "3"
    assert s.blob is True


def test_single_table_pin_elides_table():
    s = detect_scope(_ps("/cat/big"), _cfg(table="animals"))
    assert s.level == ScopeLevel.GROUP_DIR
    assert s.table == "animals"
    assert s.filters == {"label": "cat", "kind": "big"}
