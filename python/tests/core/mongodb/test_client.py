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

from unittest.mock import AsyncMock, MagicMock

import pytest

from mirage.core.mongodb._client import (get_index_stats, get_indexes,
                                         get_validator, is_view,
                                         iter_documents)


class _AsyncIter:

    def __init__(self, items):
        self._items = list(items)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._items:
            raise StopAsyncIteration
        return self._items.pop(0)


def _build_mock_client(docs):
    cursor = MagicMock()
    cursor.sort = MagicMock(return_value=cursor)
    cursor.batch_size = MagicMock(return_value=cursor)
    cursor.__aiter__ = lambda self: _AsyncIter(docs).__aiter__()
    col = MagicMock()
    col.find = MagicMock(return_value=cursor)
    db = MagicMock()
    db.__getitem__.return_value = col
    client = MagicMock()
    client.__getitem__.return_value = db
    return client, col, cursor


@pytest.mark.asyncio
async def test_iter_documents_yields_each_doc_in_order():
    docs = [{"_id": i, "v": i * 10} for i in range(3)]
    client, col, cursor = _build_mock_client(docs)
    out = []
    async for doc in iter_documents(client, "db1", "coll1", batch_size=100):
        out.append(doc)
    assert out == docs
    col.find.assert_called_once_with({}, None)
    cursor.batch_size.assert_called_once_with(100)
    cursor.sort.assert_not_called()


@pytest.mark.asyncio
async def test_iter_documents_applies_filter_projection_and_sort():
    docs = [{"_id": 1, "x": 5}]
    client, col, cursor = _build_mock_client(docs)
    out = []
    async for doc in iter_documents(client,
                                    "db1",
                                    "coll1",
                                    filter={"x": {
                                        "$gt": 0
                                    }},
                                    projection={"x": 1},
                                    sort=[("_id", -1)],
                                    batch_size=50):
        out.append(doc)
    assert out == docs
    col.find.assert_called_once_with({"x": {"$gt": 0}}, {"x": 1})
    cursor.sort.assert_called_once_with([("_id", -1)])
    cursor.batch_size.assert_called_once_with(50)


@pytest.mark.asyncio
async def test_iter_documents_empty_yields_nothing():
    client, _, _ = _build_mock_client([])
    out = []
    async for doc in iter_documents(client, "db1", "coll1"):
        out.append(doc)
    assert out == []


def _build_indexes_client(spec, indexes):
    spec_cursor = MagicMock()
    spec_cursor.__aiter__ = lambda self: _AsyncIter([spec]
                                                    if spec else []).__aiter__(
                                                    )
    idx_cursor = MagicMock()
    idx_cursor.__aiter__ = lambda self: _AsyncIter(indexes).__aiter__()
    col = MagicMock()
    col.list_indexes = MagicMock(return_value=idx_cursor)
    db = MagicMock()
    db.list_collections = AsyncMock(return_value=spec_cursor)
    db.__getitem__.return_value = col
    client = MagicMock()
    client.__getitem__.return_value = db
    return client, col, db


@pytest.mark.asyncio
async def test_is_view_true_when_spec_type_view():
    client, _, db = _build_indexes_client(
        spec={
            "name": "myview",
            "type": "view"
        },
        indexes=[],
    )
    assert await is_view(client, "db1", "myview") is True
    db.list_collections.assert_awaited_once_with(filter={"name": "myview"})


@pytest.mark.asyncio
async def test_is_view_false_for_regular_collection():
    client, _, _ = _build_indexes_client(
        spec={
            "name": "coll1",
            "type": "collection"
        },
        indexes=[],
    )
    assert await is_view(client, "db1", "coll1") is False


@pytest.mark.asyncio
async def test_is_view_false_when_collection_absent():
    client, _, _ = _build_indexes_client(spec=None, indexes=[])
    assert await is_view(client, "db1", "missing") is False


@pytest.mark.asyncio
async def test_get_indexes_returns_indexes_for_collection():
    indexes = [{"name": "_id_", "key": {"_id": 1}}]
    client, col, db = _build_indexes_client(
        spec={
            "name": "coll1",
            "type": "collection"
        },
        indexes=indexes,
    )
    out = await get_indexes(client, "db1", "coll1")
    assert out == indexes
    db.list_collections.assert_awaited_once_with(filter={"name": "coll1"})
    col.list_indexes.assert_called_once_with()


def _build_validator_client(spec):
    spec_cursor = MagicMock()
    spec_cursor.__aiter__ = lambda self: _AsyncIter([spec]
                                                    if spec else []).__aiter__(
                                                    )
    db = MagicMock()
    db.list_collections = AsyncMock(return_value=spec_cursor)
    client = MagicMock()
    client.__getitem__.return_value = db
    return client, db


@pytest.mark.asyncio
async def test_get_validator_returns_json_schema_when_present():
    spec = {
        "name": "movies",
        "options": {
            "validator": {
                "$jsonSchema": {
                    "bsonType": "object",
                    "required": ["title"]
                }
            }
        }
    }
    client, db = _build_validator_client(spec)
    out = await get_validator(client, "db1", "movies")
    assert out == {"bsonType": "object", "required": ["title"]}
    db.list_collections.assert_awaited_once_with(filter={"name": "movies"})


@pytest.mark.asyncio
async def test_get_validator_returns_none_without_validator():
    client, _ = _build_validator_client({"name": "movies", "options": {}})
    assert await get_validator(client, "db1", "movies") is None


@pytest.mark.asyncio
async def test_get_validator_returns_none_when_collection_missing():
    client, _ = _build_validator_client(None)
    assert await get_validator(client, "db1", "ghost") is None


def _build_indexstats_client(rows):
    cursor = MagicMock()
    cursor.__aiter__ = lambda self: _AsyncIter(rows).__aiter__()
    col = MagicMock()
    col.aggregate = MagicMock(return_value=cursor)
    db = MagicMock()
    db.__getitem__.return_value = col
    client = MagicMock()
    client.__getitem__.return_value = db
    return client, col


@pytest.mark.asyncio
async def test_get_index_stats_returns_map_keyed_by_name():
    rows = [
        {
            "name": "_id_",
            "accesses": {
                "ops": 1234,
                "since": "2026-01-01"
            }
        },
        {
            "name": "title_text",
            "accesses": {
                "ops": 5678,
                "since": "2026-02-01"
            }
        },
    ]
    client, col = _build_indexstats_client(rows)
    out = await get_index_stats(client, "db1", "coll1")
    assert out["title_text"] == {"ops": 5678, "since": "2026-02-01"}
    assert out["_id_"] == {"ops": 1234, "since": "2026-01-01"}
    col.aggregate.assert_called_once_with([{"$indexStats": {}}])


@pytest.mark.asyncio
async def test_get_index_stats_empty_when_view():
    client, _ = _build_indexstats_client([])
    out = await get_index_stats(client, "db1", "myview")
    assert out == {}


@pytest.mark.asyncio
async def test_get_indexes_returns_empty_for_view_without_listing():
    client, col, db = _build_indexes_client(
        spec={
            "name": "myview",
            "type": "view"
        },
        indexes=[],
    )
    out = await get_indexes(client, "db1", "myview")
    assert out == []
    db.list_collections.assert_awaited_once_with(filter={"name": "myview"})
    col.list_indexes.assert_not_called()
