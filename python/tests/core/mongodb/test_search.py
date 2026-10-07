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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.mongodb.scope import detect_scope
from mirage.core.mongodb.search import SEARCHERS
from mirage.vfs.mongodb.config import MongoDBConfig
from mirage.vfs.types import SearchQuery

DOCS = {
    ("app", "books"): [
        '{"_id": {"$oid": "65a1f0000000000000000001"}, "title": "Ada", '
        '"year": 2020}',
        '{"_id": {"$oid": "65a1f0000000000000000002"}, "title": "ada", '
        '"year": 2021}',
    ],
    ("app", "recent"): ['{"_id": 3, "title": "Ada live", "year": 2022}'],
}


async def _fake_stream(accessor, path, index=None):
    key = tuple(path.vfs_path.split("/")[i] for i in (0, 2))
    for line in DOCS[key]:
        yield (line + "\n").encode()


async def _fake_collections(client, database, kind=None):
    return ["books"] if kind.value == "collection" else ["recent"]


@pytest.fixture
def catalog():
    with (
        patch("mirage.core.mongodb.search.read_stream", new=_fake_stream),
        patch(
            "mirage.core.mongodb.search.list_collections",
            new=_fake_collections,
        ),
        patch(
            "mirage.core.mongodb.search.list_databases",
            new=AsyncMock(return_value=["app"]),
        ),
        patch(
            "mirage.core.mongodb.search.build_collection_schema_json",
            new=AsyncMock(return_value={"fields": {"year": "int"}}),
        ),
        patch(
            "mirage.core.mongodb.search.build_database_json",
            new=AsyncMock(return_value={"database": "app"}),
        ),
    ):
        yield


def _accessor() -> MongoDBAccessor:
    return MongoDBAccessor(
        config=MongoDBConfig(uri="mongodb://localhost:27017")
    )


def _match(path: str) -> ScopeMatch:
    return detect_scope(path)


async def _search(path: str, pattern: str, **flags) -> list[str]:
    match = _match(path)
    results = await SEARCHERS[match.kind](
        _accessor(),
        match,
        SearchQuery(
            query=pattern,
            options={
                "grep": {"syntax": "basic", "fixed_string": False, **flags}
            },
        ),
    )
    return [text for _, text in results]


@pytest.mark.asyncio
async def test_a_number_matches_as_the_line_spells_it(catalog):
    """The $regex ran only over string fields sampled from 100
    documents, so a number (or an ObjectId, a date, a key) never
    matched, while grep over documents.jsonl found it."""
    lines = await _search("/app/collections/books", "2020")
    assert lines == [
        "app/collections/books/documents.jsonl:" + DOCS[("app", "books")][0]
    ]


@pytest.mark.asyncio
async def test_case_is_folded_only_under_i(catalog):
    # `$options: "i"` folded case whatever -i said.
    sensitive = await _search("/app/collections/books", "Ada")
    folded = await _search("/app/collections/books", "Ada", ignore_case=True)
    assert len(sensitive) == 1
    assert len(folded) == 2


@pytest.mark.asyncio
async def test_a_database_covers_views_and_its_metadata_files(catalog):
    lines = await _search("/app", "year")
    assert [line.split(":", 1)[0] for line in lines] == [
        "app/collections/books/documents.jsonl",
        "app/collections/books/documents.jsonl",
        "app/collections/books/schema.json",
        "app/views/recent/documents.jsonl",
        "app/views/recent/schema.json",
    ]
    assert await _search("/app", '"database": "app"') == [
        'app/database.json:{"database": "app"}'
    ]


@pytest.mark.asyncio
async def test_there_is_no_result_cap():
    # It stopped at `default_search_limit` documents per collection.
    many = {
        ("app", "books"): [f'{{"_id": {i}, "n": "x"}}' for i in range(150)]
    }
    search = "mirage.core.mongodb.search"
    with (
        patch.dict(DOCS, many),
        patch(f"{search}.read_stream", new=_fake_stream),
        patch(
            f"{search}.build_collection_schema_json",
            new=AsyncMock(return_value={}),
        ),
    ):
        lines = await _search("/app/collections/books", '"x"')
    assert len(lines) == 150
