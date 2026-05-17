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
from unittest.mock import AsyncMock, patch

import pytest
from bson import ObjectId

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.mongodb.read import read
from mirage.resource.mongodb.config import MongoDBConfig
from mirage.types import PathSpec

DOCS_PATH = "/sample_mflix/collections/movies/documents.jsonl"
SCHEMA_PATH = "/sample_mflix/collections/movies/schema.json"
DBJSON_PATH = "/sample_mflix/database.json"


async def _gen(items):
    for item in items:
        yield item


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.fixture
def accessor():
    return MongoDBAccessor(config=MongoDBConfig(
        uri="mongodb://localhost:27017"))


def _patched_iter(docs):
    return patch("mirage.core.mongodb.stream.iter_documents",
                 new=lambda *args, **kwargs: _gen(docs))


def _path(s: str) -> PathSpec:
    return PathSpec(original=s, directory=s)


@pytest.fixture(autouse=True)
def _stub_existence_checks():
    with patch(
            "mirage.core.mongodb.read.database_exists",
            new_callable=AsyncMock,
            return_value=True,
    ), patch(
            "mirage.core.mongodb.read.entity_exists",
            new_callable=AsyncMock,
            return_value=True,
    ):
        yield


@pytest.mark.asyncio
async def test_read_documents_returns_extended_json_jsonl(accessor, index):
    oid = ObjectId()
    docs = [
        {
            "_id": oid,
            "title": "Movie 1"
        },
        {
            "_id": ObjectId(),
            "title": "Movie 2"
        },
    ]
    with _patched_iter(docs):
        result = await read(accessor, _path(DOCS_PATH), index)
    lines = result.decode().strip().split("\n")
    assert len(lines) == 2
    first = json.loads(lines[0])
    assert first["title"] == "Movie 1"
    assert first["_id"] == {"$oid": str(oid)}


@pytest.mark.asyncio
async def test_read_documents_no_doc_cap(accessor, index):
    docs = [{"_id": ObjectId(), "x": i} for i in range(50)]
    with _patched_iter(docs):
        result = await read(accessor, _path(DOCS_PATH), index)
    lines = result.decode().strip().split("\n")
    assert len(lines) == 50


@pytest.mark.asyncio
async def test_read_documents_empty(accessor, index):
    with _patched_iter([]):
        result = await read(accessor, _path(DOCS_PATH), index)
    assert result == b""


@pytest.mark.asyncio
async def test_read_schema_json_returns_jsonschema_payload(accessor, index):
    payload = {
        "database": "sample_mflix",
        "name": "movies",
        "kind": "collection",
        "validator": None,
        "fields": [],
        "primary_key": "_id",
        "indexes": [],
        "document_count": 0,
        "sampled": 100,
    }
    with patch("mirage.core.mongodb.read.build_collection_schema_json",
               new=AsyncMock(return_value=payload)):
        result = await read(accessor, _path(SCHEMA_PATH), index)
    parsed = json.loads(result.decode())
    assert parsed == payload


@pytest.mark.asyncio
async def test_read_database_json_returns_payload(accessor, index):
    payload = {
        "database": "sample_mflix",
        "collections": [{
            "name": "movies",
            "document_count": 100
        }],
        "views": [{
            "name": "top_rated"
        }],
    }
    with patch("mirage.core.mongodb.read.build_database_json",
               new=AsyncMock(return_value=payload)):
        result = await read(accessor, _path(DBJSON_PATH), index)
    parsed = json.loads(result.decode())
    assert parsed == payload


@pytest.mark.asyncio
async def test_read_unknown_path_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await read(accessor, _path("/garbage/path"), index)


@pytest.mark.asyncio
async def test_read_kind_dir_path_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await read(accessor, _path("/sample_mflix/collections"), index)


@pytest.mark.asyncio
async def test_read_documents_missing_collection_raises(accessor, index):
    with patch(
            "mirage.core.mongodb.read.entity_exists",
            new_callable=AsyncMock,
            return_value=False,
    ):
        with pytest.raises(FileNotFoundError):
            await read(
                accessor,
                _path("/sample_mflix/collections/ghost/documents.jsonl"),
                index)


@pytest.mark.asyncio
async def test_read_database_json_missing_db_raises(accessor, index):
    with patch(
            "mirage.core.mongodb.read.database_exists",
            new_callable=AsyncMock,
            return_value=False,
    ):
        with pytest.raises(FileNotFoundError):
            await read(accessor, _path("/ghost/database.json"), index)
