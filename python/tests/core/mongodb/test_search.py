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

from unittest.mock import AsyncMock

import pytest

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.core.mongodb.search import DEPTH, holds_filter, lines_containing
from mirage.types import PathSpec
from mirage.vfs.mongodb.config import MongoDBConfig

DOCS = "/shop/collections/orders/documents.jsonl"


@pytest.fixture(autouse=True)
def visible_collections(monkeypatch):
    monkeypatch.setattr(
        "mirage.core.mongodb.readdir.entity_exists",
        AsyncMock(return_value=True),
    )


def _accessor(**config) -> MongoDBAccessor:
    return MongoDBAccessor(
        config=MongoDBConfig(uri="mongodb://localhost:27017", **config)
    )


def _path(s: str = DOCS) -> PathSpec:
    return PathSpec(virtual=s, directory=s, vfs_path=s.strip("/"))


def _found(monkeypatch, docs):
    asked = []

    async def found(client, database, name, filter=None, sort=None, **kw):
        asked.append((database, name, filter, sort))
        for doc in docs:
            yield doc

    monkeypatch.setattr("mirage.core.mongodb.search.iter_documents", found)
    return asked


async def _lines(answer) -> bytes:
    return b"".join([chunk async for chunk in answer])


@pytest.mark.asyncio
async def test_streams_the_documents_mongodb_names_in_id_order(monkeypatch):
    asked = _found(monkeypatch, [{"_id": 1, "who": "lovelace", "secret": "x"}])
    accessor = _accessor(elide_fields={"shop.orders": ["secret"]})
    answer = await lines_containing(accessor, _path(), "lovelace")
    assert await _lines(answer) == b'{"_id": 1, "who": "lovelace"}\n'
    [(database, name, flt, sort)] = asked
    assert (database, name, sort) == ("shop", "orders", [("_id", 1)])
    assert flt == holds_filter(["lovelace"])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text, why",
    [
        ("date", "a date's wrapper key"),
        ("oid", "an ObjectId's wrapper key"),
        ("nfinit", "inside Infinity"),
        ("true", "a JSON literal"),
        ("ada", "a run of hex letters an id can hold"),
        ("x1", "a digit"),
        ("a:b", "punctuation"),
        ("t", "an escape's letter alone"),
    ],
)
async def test_declines_a_text_outside_keys_and_strings(
    monkeypatch, text, why
):
    asked = _found(monkeypatch, [])
    assert await lines_containing(_accessor(), _path(), text) is None, why
    assert asked == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path",
    [
        "/shop/database.json",
        "/shop/collections/orders/schema.json",
        "/shop/collections/orders",
    ],
)
async def test_declines_any_other_file(monkeypatch, path):
    asked = _found(monkeypatch, [])
    assert await lines_containing(_accessor(), _path(path), "lovelace") is None
    assert asked == []


def test_the_filter_walks_every_key_and_string_to_a_depth():
    expr = holds_filter(["ada"])["$expr"]
    levels = 0
    while "$let" in expr:
        levels += 1
        expr = expr["$let"]["in"]
    # The seed level, then one per depth; a document nested deeper is a
    # candidate.
    assert levels == DEPTH + 1
    assert expr == {
        "$or": [f"$$s{DEPTH}.hit", {"$gt": [{"$size": f"$$s{DEPTH}.next"}, 0]}]
    }


@pytest.mark.parametrize(
    "queries, escaped",
    [
        (["bob"], True),
        (["unicode"], True),
        (["need"], False),
        (["need", "eed"], True),
    ],
)
def test_a_text_that_can_start_inside_an_escape_takes_non_ascii(
    queries, escaped
):
    # A line spells a character outside ASCII as \uXXXX on one host, so a
    # text starting with u or a hex letter may begin inside the escape.
    regexes = []
    _gather(holds_filter(queries), regexes)
    assert ("[^\\x00-\\x7f]" in regexes) is escaped


def _gather(value, regexes: list) -> None:
    if isinstance(value, dict):
        if "regex" in value:
            regexes.append(value["regex"])
        for item in value.values():
            _gather(item, regexes)
    elif isinstance(value, list):
        for item in value:
            _gather(item, regexes)
