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

import json
from unittest.mock import patch

import pytest
from bson import ObjectId

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.mongodb.read import read
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


def _patched_iter(docs):
    return patch("mirage.core.mongodb.stream.iter_documents",
                 new=lambda *args, **kwargs: _gen(docs))


@pytest.mark.asyncio
async def test_read_collection_returns_jsonl_extended_json(accessor, index):
    oid = ObjectId()
    docs = [
        {"_id": oid, "title": "Movie 1"},
        {"_id": ObjectId(), "title": "Movie 2"},
    ]
    with _patched_iter(docs):
        result = await read(
            accessor,
            PathSpec(original="/sample_mflix/movies.jsonl",
                     directory="/sample_mflix/movies.jsonl"), index)
    lines = result.decode().strip().split("\n")
    assert len(lines) == 2
    first = json.loads(lines[0])
    assert first["title"] == "Movie 1"
    assert first["_id"] == {"$oid": str(oid)}


@pytest.mark.asyncio
async def test_read_returns_all_streamed_docs_no_cap(accessor, index):
    docs = [{"_id": ObjectId(), "x": i} for i in range(10)]
    with _patched_iter(docs):
        result = await read(
            accessor,
            PathSpec(original="/sample_mflix/movies.jsonl",
                     directory="/sample_mflix/movies.jsonl"), index)
    lines = result.decode().strip().split("\n")
    assert len(lines) == 10
    for line in lines:
        parsed = json.loads(line)
        assert isinstance(parsed["_id"], dict)
        assert "$oid" in parsed["_id"]


@pytest.mark.asyncio
async def test_read_empty_collection(accessor, index):
    with _patched_iter([]):
        result = await read(
            accessor,
            PathSpec(original="/sample_mflix/movies.jsonl",
                     directory="/sample_mflix/movies.jsonl"), index)
    assert result == b""


@pytest.mark.asyncio
async def test_read_invalid_path_raises(accessor, index):
    with _patched_iter([]):
        with pytest.raises(FileNotFoundError):
            await read(
                accessor,
                PathSpec(original="/not_a_jsonl_file",
                         directory="/not_a_jsonl_file"), index)
