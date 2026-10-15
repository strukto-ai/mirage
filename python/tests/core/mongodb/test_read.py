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
from mirage.core.mongodb.read import read
from mirage.types import PathSpec
from mirage.vfs.mongodb.config import MongoDBConfig
from mirage.vfs.mongodb.mongodb import MongoDBVFS
from tests.fixtures.vfs_io import io_for

DOCS_PATH = "/sample_mflix/collections/movies/documents.jsonl"
SCHEMA_PATH = "/sample_mflix/collections/movies/schema.json"
DBJSON_PATH = "/sample_mflix/database.json"


async def _gen(items):
    for item in items:
        yield item


@pytest.fixture
def accessor():
    return MongoDBAccessor(
        config=MongoDBConfig(uri="mongodb://localhost:27017")
    )


def _patched_iter(docs):
    return patch(
        "mirage.core.mongodb.stream.iter_documents",
        new=lambda *args, **kwargs: _gen(docs),
    )


def _path(s: str) -> PathSpec:
    return PathSpec(virtual=s, directory=s, vfs_path=s.strip("/"))


@pytest.fixture(autouse=True)
def _stub_existence_checks():
    with (
        patch(
            "mirage.core.mongodb.readdir.database_exists",
            new_callable=AsyncMock,
            return_value=True,
        ),
        patch(
            "mirage.core.mongodb.readdir.entity_exists",
            new_callable=AsyncMock,
            return_value=True,
        ),
    ):
        yield


@pytest.mark.asyncio
async def test_read_documents_returns_extended_json_jsonl(accessor):
    oid = ObjectId()
    docs = [
        {"_id": oid, "title": "Movie 1"},
        {"_id": ObjectId(), "title": "Movie 2"},
    ]
    with _patched_iter(docs):
        result = await read(accessor, _path(DOCS_PATH))
    lines = result.decode().strip().split("\n")
    assert len(lines) == 2
    first = json.loads(lines[0])
    assert first["title"] == "Movie 1"
    assert first["_id"] == {"$oid": str(oid)}


@pytest.mark.asyncio
async def test_read_documents_no_doc_cap(accessor):
    docs = [{"_id": ObjectId(), "x": i} for i in range(50)]
    with _patched_iter(docs):
        result = await read(accessor, _path(DOCS_PATH))
    lines = result.decode().strip().split("\n")
    assert len(lines) == 50


@pytest.mark.asyncio
async def test_read_documents_empty(accessor):
    with _patched_iter([]):
        result = await read(accessor, _path(DOCS_PATH))
    assert result == b""


@pytest.mark.asyncio
async def test_read_schema_json_returns_jsonschema_payload(accessor):
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
    with patch(
        "mirage.core.mongodb.read.build_collection_schema_json",
        new=AsyncMock(return_value=payload),
    ):
        result = await read(accessor, _path(SCHEMA_PATH))
    parsed = json.loads(result.decode())
    assert parsed == payload


@pytest.mark.asyncio
async def test_read_database_json_returns_payload(accessor):
    payload = {
        "database": "sample_mflix",
        "collections": [{"name": "movies", "document_count": 100}],
        "views": [{"name": "top_rated"}],
    }
    with patch(
        "mirage.core.mongodb.read.build_database_json",
        new=AsyncMock(return_value=payload),
    ):
        result = await read(accessor, _path(DBJSON_PATH))
    parsed = json.loads(result.decode())
    assert parsed == payload


@pytest.mark.asyncio
async def test_read_unknown_path_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await read(accessor, _path("/garbage/path"))


@pytest.mark.asyncio
async def test_read_kind_dir_path_raises(accessor):
    # A probed directory shape is no proof the node exists, so the read
    # reports absence rather than EISDIR.
    with pytest.raises(FileNotFoundError):
        await read(accessor, _path("/sample_mflix/collections"))


@pytest.mark.asyncio
async def test_read_documents_missing_collection_raises(accessor):
    with patch(
        "mirage.core.mongodb.readdir.entity_exists",
        new_callable=AsyncMock,
        return_value=False,
    ):
        with pytest.raises(FileNotFoundError):
            await read(
                accessor,
                _path("/sample_mflix/collections/ghost/documents.jsonl"),
            )


@pytest.mark.asyncio
async def test_read_database_json_missing_db_raises(accessor):
    with patch(
        "mirage.core.mongodb.readdir.database_exists",
        new_callable=AsyncMock,
        return_value=False,
    ):
        with pytest.raises(FileNotFoundError):
            await read(accessor, _path("/ghost/database.json"))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path,builder",
    [
        (DBJSON_PATH, "build_database_json"),
        (SCHEMA_PATH, "build_collection_schema_json"),
    ],
)
async def test_registered_stream_matches_read_for_metadata(
    accessor, path, builder
):
    with patch(
        "mirage.core.mongodb.read." + builder,
        new=AsyncMock(return_value={"name": "café", "fields": []}),
    ):
        expected = await io_for(MongoDBVFS, accessor).read_bytes(
            accessor, _path(path)
        )
        actual = b"".join(
            [
                chunk
                async for chunk in io_for(MongoDBVFS, accessor).read_stream(
                    accessor, _path(path)
                )
            ]
        )
    assert actual == expected
    assert b"fields" in actual


@pytest.mark.asyncio
async def test_registered_document_stream_is_lazy(accessor):
    consumed = 0

    async def documents(*args, **kwargs):
        nonlocal consumed
        for i in range(1_000_000):
            consumed += 1
            yield {"_id": i, "value": "x" * 1024}

    with patch("mirage.core.mongodb.stream.iter_documents", new=documents):
        stream = io_for(MongoDBVFS, accessor).read_stream(
            accessor, _path(DOCS_PATH)
        )
        first = await anext(stream)
        assert consumed == 1
        assert json.loads(first)["_id"] == 0
        await stream.aclose()
