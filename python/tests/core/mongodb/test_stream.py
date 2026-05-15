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

import datetime as dt
import json
from unittest.mock import patch

import pytest
from bson import Decimal128, ObjectId

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.mongodb.stream import read_stream
from mirage.resource.mongodb.config import MongoDBConfig
from mirage.types import PathSpec


async def _gen(items):
    for item in items:
        yield item


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.fixture
def accessor():
    return MongoDBAccessor(
        config=MongoDBConfig(uri="mongodb://localhost:27017"))


@pytest.fixture
def single_db_accessor():
    return MongoDBAccessor(config=MongoDBConfig(
        uri="mongodb://localhost:27017", databases=["db1"]))


def _patched_iter(docs):
    return patch("mirage.core.mongodb.stream.iter_documents",
                 new=lambda *args, **kwargs: _gen(docs))


async def _collect(gen):
    chunks = []
    async for chunk in gen:
        chunks.append(chunk)
    return b"".join(chunks)


@pytest.mark.asyncio
async def test_read_stream_yields_one_jsonl_line_per_doc(accessor, index):
    oid_a, oid_b = ObjectId(), ObjectId()
    docs = [{"_id": oid_a, "title": "A"}, {"_id": oid_b, "title": "B"}]
    path = PathSpec(original="/db1/coll1.jsonl",
                    directory="/db1/coll1.jsonl")
    with _patched_iter(docs):
        data = await _collect(read_stream(accessor, path, index))
    lines = [line for line in data.decode().split("\n") if line]
    assert len(lines) == 2
    first = json.loads(lines[0])
    assert first["title"] == "A"
    assert first["_id"] == {"$oid": str(oid_a)}


@pytest.mark.asyncio
async def test_read_stream_preserves_bson_types_via_extended_json(
        accessor, index):
    docs = [{
        "_id": ObjectId("65f0000000000000000000a1"),
        "date": dt.datetime(2026, 5, 15, 12, 30, 45,
                            tzinfo=dt.timezone.utc),
        "decimal": Decimal128("123.456"),
    }]
    path = PathSpec(original="/db1/coll1.jsonl",
                    directory="/db1/coll1.jsonl")
    with _patched_iter(docs):
        data = await _collect(read_stream(accessor, path, index))
    parsed = json.loads(data.decode().strip())
    assert parsed["_id"] == {"$oid": "65f0000000000000000000a1"}
    assert "$date" in parsed["date"]
    assert parsed["decimal"] == {"$numberDecimal": "123.456"}


@pytest.mark.asyncio
async def test_read_stream_empty_yields_nothing(accessor, index):
    path = PathSpec(original="/db1/coll1.jsonl",
                    directory="/db1/coll1.jsonl")
    with _patched_iter([]):
        chunks = []
        async for chunk in read_stream(accessor, path, index):
            chunks.append(chunk)
    assert chunks == []


@pytest.mark.asyncio
async def test_read_stream_short_circuits_when_consumer_closes(
        accessor, index):
    consumed: list[int] = []

    async def _instrumented(*_args, **_kwargs):
        for i in range(1000):
            consumed.append(i)
            yield {"_id": ObjectId(), "i": i}

    path = PathSpec(original="/db1/coll1.jsonl",
                    directory="/db1/coll1.jsonl")
    with patch("mirage.core.mongodb.stream.iter_documents",
               new=_instrumented):
        gen = read_stream(accessor, path, index)
        await gen.__anext__()
        await gen.aclose()
    assert len(consumed) <= 2


@pytest.mark.asyncio
async def test_read_stream_single_db_mode_collapses_path(
        single_db_accessor, index):
    docs = [{"_id": ObjectId(), "v": 1}]
    path = PathSpec(original="/coll1.jsonl", directory="/coll1.jsonl")
    with _patched_iter(docs):
        data = await _collect(read_stream(single_db_accessor, path, index))
    assert data
    parsed = json.loads(data.decode().strip())
    assert parsed["v"] == 1


@pytest.mark.asyncio
async def test_read_stream_directory_path_raises(accessor, index):
    path = PathSpec(original="/db1", directory="/db1")
    with _patched_iter([]):
        with pytest.raises(FileNotFoundError):
            async for _ in read_stream(accessor, path, index):
                pass
