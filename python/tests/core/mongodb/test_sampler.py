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

from unittest.mock import MagicMock

import pytest
from bson import Decimal128, ObjectId

from mirage.core.mongodb._sampler import sample_field_types


class _AsyncIter:

    def __init__(self, items):
        self._items = list(items)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._items:
            raise StopAsyncIteration
        return self._items.pop(0)


def _col(docs):
    col = MagicMock()
    col.aggregate = MagicMock(return_value=_AsyncIter(docs))
    return col


@pytest.mark.asyncio
async def test_sample_field_types_tallies_types_and_presence():
    docs = [
        {
            "_id": 1,
            "title": "Hi",
            "year": 2020,
            "tags": ["a", "b"]
        },
        {
            "_id": 2,
            "title": "Bye",
            "year": "2021",
            "tags": ["c"]
        },
        {
            "_id": 3,
            "title": "Yo"
        },
    ]
    out = await sample_field_types(_col(docs), sample_size=3)
    by_path = {f["path"]: f for f in out}
    assert "_id" not in by_path
    assert by_path["title"]["presence"] == 1.0
    assert by_path["title"]["types"] == {"string": 1.0}
    assert by_path["year"]["presence"] == pytest.approx(2 / 3)
    assert set(by_path["year"]["types"].keys()) == {"int", "string"}
    assert by_path["tags"]["types"] == {"array<string>": pytest.approx(2 / 3)}


@pytest.mark.asyncio
async def test_sample_field_types_recognizes_fixed_numeric_arrays():
    docs = [{"_id": i, "embedding": [0.1] * 1024} for i in range(5)]
    out = await sample_field_types(_col(docs), sample_size=5)
    by_path = {f["path"]: f for f in out}
    assert by_path["embedding"]["types"] == {"array<double>(1024)": 1.0}


@pytest.mark.asyncio
async def test_sample_field_types_walks_nested_objects():
    docs = [
        {
            "_id": 1,
            "metadata": {
                "tag": "a",
                "ratings": [1.0, 2.0]
            }
        },
        {
            "_id": 2,
            "metadata": {
                "tag": "b",
                "extra": ObjectId()
            }
        },
    ]
    out = await sample_field_types(_col(docs), sample_size=2)
    paths = {f["path"] for f in out}
    assert "metadata.tag" in paths
    assert "metadata.ratings" in paths
    assert "metadata.extra" in paths


@pytest.mark.asyncio
async def test_sample_field_types_handles_bson_scalars():
    docs = [{
        "_id": 1,
        "dec": Decimal128("1.23"),
        "oid": ObjectId("65f0000000000000000000a1")
    }]
    out = await sample_field_types(_col(docs), sample_size=1)
    by_path = {f["path"]: f for f in out}
    assert by_path["dec"]["types"] == {"decimal": 1.0}
    assert by_path["oid"]["types"] == {"objectId": 1.0}


@pytest.mark.asyncio
async def test_sample_field_types_empty_sample_returns_empty_list():
    out = await sample_field_types(_col([]), sample_size=5)
    assert out == []
