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

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mirage.core.mongodb.search import search_collection, search_database


class _AsyncIter:

    def __init__(self, items):
        self._items = list(items)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._items:
            raise StopAsyncIteration
        return self._items.pop(0)


def _agg_iter(items):
    return _AsyncIter(items)


def _build_search_client(sampled_docs, matched_docs):
    col = MagicMock()
    col.aggregate = MagicMock(return_value=_agg_iter(sampled_docs))
    cursor = MagicMock()
    cursor.limit = MagicMock(return_value=cursor)
    cursor.to_list = AsyncMock(return_value=matched_docs)
    col.find = MagicMock(return_value=cursor)
    db = MagicMock()
    db.__getitem__.return_value = col
    client = MagicMock()
    client.__getitem__.return_value = db
    return client, col


@pytest.mark.asyncio
async def test_search_collection_unions_string_fields_across_sampled_docs():
    sampled = [
        {
            "_id": 1,
            "title": "Hello"
        },
        {
            "_id": 2,
            "body": "World"
        },
        {
            "_id": 3,
            "metadata": {
                "tag": "x"
            }
        },
    ]
    matched = [{"_id": 2, "body": "World matches"}]
    client, col = _build_search_client(sampled, matched)
    with patch("mirage.core.mongodb.search.get_indexes",
               new=AsyncMock(return_value=[])):
        out = await search_collection(client,
                                      "db1",
                                      "coll1",
                                      "World",
                                      limit=10)
    assert out == matched
    filter_arg = col.find.call_args[0][0]
    or_fields = {list(clause.keys())[0] for clause in filter_arg["$or"]}
    assert {"title", "body", "metadata.tag"}.issubset(or_fields)


@pytest.mark.asyncio
async def test_search_collection_uses_text_when_textIndexVersion_present():
    indexes = [{
        "name": "title_text",
        "key": {
            "_fts": "text",
            "_ftsx": 1
        },
        "weights": {
            "title": 1
        },
        "textIndexVersion": 3,
    }]
    client, col = _build_search_client([], [{"_id": 1}])
    with patch("mirage.core.mongodb.search.get_indexes",
               new=AsyncMock(return_value=indexes)):
        await search_collection(client, "db1", "coll1", "query", limit=10)
    assert col.find.call_args[0][0] == {"$text": {"$search": "query"}}


@pytest.mark.asyncio
async def test_search_collection_no_string_fields_returns_no_results():
    sampled = [{"_id": 1, "n": 42}, {"_id": 2, "n": 7}]
    client, col = _build_search_client(sampled, [])
    with patch("mirage.core.mongodb.search.get_indexes",
               new=AsyncMock(return_value=[])):
        out = await search_collection(client,
                                      "db1",
                                      "coll1",
                                      "anything",
                                      limit=10)
    assert out == []
    assert col.find.call_args is None


@pytest.mark.asyncio
async def test_search_database_runs_collections_concurrently():
    barrier = asyncio.Barrier(3)

    async def slow_search(client, database, col, pattern, limit):
        await barrier.wait()
        return [{"_id": col, "v": col}]

    with patch("mirage.core.mongodb.search.list_collections",
               new=AsyncMock(return_value=["a", "b", "c"])):
        with patch("mirage.core.mongodb.search.search_collection",
                   new=slow_search):
            out = await asyncio.wait_for(
                search_database(None, "db", "p", 10),
                timeout=2.0,
            )
    assert {col for _, col, _ in out} == {"a", "b", "c"}
