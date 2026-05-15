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

import pytest
from unittest.mock import MagicMock

from mirage.core.mongodb._client import iter_documents


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
                                    filter={"x": {"$gt": 0}},
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
