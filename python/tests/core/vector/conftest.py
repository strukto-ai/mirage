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

import operator

import pytest

from mirage.accessor.base import Accessor
from mirage.core.hierarchy.bind import per_accessor
from mirage.core.hierarchy.codec import PATH_SAFE, Codec
from mirage.core.hierarchy.scope import make_detect_scope
from mirage.core.vector.scope import blob_leaf, filters_of, row_scopes
from mirage.core.vector.types import VectorTree
from mirage.types import ContentType, FileStat, FileType

TABLE = "animals"

ROWS = [
    dict(id="1", label="cat", _score=0.9, _distance=0.9),
    dict(id="2", label="dog", _score=0.2, _distance=0.2),
]


class StubAccessor(Accessor):
    def __init__(self, pinned: str | None = None) -> None:
        self.pinned = pinned
        self.reads = 0


def _detect(accessor):
    leaves = [
        ("row_text", Codec(suffix=".txt"), ContentType.TEXT),
        blob_leaf("png"),
    ]
    return make_detect_scope(
        row_scopes(accessor.pinned is not None, [PATH_SAFE], leaves)
    )


async def _list_tables(accessor):
    return [TABLE]


async def _table_exists(accessor, name):
    return name == TABLE


async def _children(accessor, match):
    label = filters_of(["label"], match).get("label")
    if label is None:
        return [
            FileStat(name=row["label"], type=FileType.DIRECTORY)
            for row in ROWS
        ]
    return [
        FileStat(name=f"{row['id']}.txt", type=FileType.FILE)
        for row in ROWS
        if row["label"] == label
    ]


async def _read_text(accessor, match, path, entry, parent):
    accessor.reads += 1
    return f"row {match.slots['row_id']}\n".encode()


async def _read_blob(accessor, match, path, entry, parent):
    return b"PNG"


async def _search_rows(accessor, table, query, limit):
    return ROWS[:limit]


def _pinned(accessor):
    return accessor.pinned


def _search_limit(accessor):
    return 10


def _hit(accessor, row):
    return [row["label"], f"{row['id']}.txt"], f"{row['label']}\n".encode()


def stub_tree(rank_key: str = "_score", drops=operator.lt) -> VectorTree:
    return VectorTree(
        detect=per_accessor(_detect),
        pinned=_pinned,
        search_limit=_search_limit,
        list_tables=_list_tables,
        table_exists=_table_exists,
        children=_children,
        readers={"row_text": _read_text, "row_blob": _read_blob},
        search_rows=_search_rows,
        rank_key=rank_key,
        drops=drops,
        hit=_hit,
    )


@pytest.fixture
def tree() -> VectorTree:
    return stub_tree()


@pytest.fixture
def distance_tree() -> VectorTree:
    return stub_tree("_distance", operator.gt)


@pytest.fixture
def accessor() -> StubAccessor:
    return StubAccessor()


@pytest.fixture
def pinned() -> StubAccessor:
    return StubAccessor(TABLE)
