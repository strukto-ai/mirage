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
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.mongodb.stat import stat
from mirage.resource.mongodb.config import MongoDBConfig
from mirage.types import FileType, PathSpec


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.fixture
def accessor():
    return MongoDBAccessor(config=MongoDBConfig(
        uri="mongodb://localhost:27017"))


def _path(s: str) -> PathSpec:
    return PathSpec(virtual=s, directory=s, resource_path=s.strip("/"))


@pytest.fixture(autouse=True)
def _stub_existence_checks():
    with patch(
            "mirage.core.mongodb.stat.database_exists",
            new_callable=AsyncMock,
            return_value=True,
    ), patch(
            "mirage.core.mongodb.stat.entity_exists",
            new_callable=AsyncMock,
            return_value=True,
    ):
        yield


@pytest.mark.asyncio
async def test_stat_root(accessor, index):
    result = await stat(accessor, _path("/"), index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_database(accessor, index):
    result = await stat(accessor, _path("/sample_mflix"), index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "sample_mflix"
    assert result.extra["database"] == "sample_mflix"


@pytest.mark.asyncio
async def test_stat_collections_kind_dir(accessor, index):
    result = await stat(accessor, _path("/sample_mflix/collections"), index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "collections"
    assert result.extra["kind"] == "collection"


@pytest.mark.asyncio
async def test_stat_views_kind_dir(accessor, index):
    result = await stat(accessor, _path("/sample_mflix/views"), index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "views"
    assert result.extra["kind"] == "view"


@pytest.mark.asyncio
async def test_stat_entity_collection(accessor, index):
    with patch("mirage.core.mongodb.stat.count_documents",
               new=AsyncMock(return_value=23519)):
        result = await stat(accessor,
                            _path("/sample_mflix/collections/movies"), index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "movies"
    assert result.extra["kind"] == "collection"
    assert result.extra["document_count"] == 23519


@pytest.mark.asyncio
async def test_stat_documents_collection_full_metadata(accessor, index):
    fake_indexes = [{"name": "_id_", "key": {"_id": 1}}]
    with (
            patch("mirage.core.mongodb.stat.is_view",
                  new=AsyncMock(return_value=False)),
            patch("mirage.core.mongodb.stat.count_documents",
                  new=AsyncMock(return_value=42)),
            patch("mirage.core.mongodb.stat.get_indexes",
                  new=AsyncMock(return_value=fake_indexes)),
    ):
        result = await stat(
            accessor,
            _path("/sample_mflix/collections/movies/documents.jsonl"), index)
    assert result.type == FileType.TEXT
    assert result.name == "documents.jsonl"
    assert result.extra["kind"] == "collection"
    assert result.extra["document_count"] == 42
    assert result.extra["indexes"] == [{"name": "_id_", "keys": {"_id": 1}}]


@pytest.mark.asyncio
async def test_stat_documents_view_skips_indexes(accessor, index):
    with (
            patch(
                "mirage.core.mongodb.stat.count_documents",
                new=AsyncMock(return_value=17),
            ),
            patch(
                "mirage.core.mongodb.stat.get_indexes",
                new=AsyncMock(side_effect=AssertionError(
                    "get_indexes must not be called for views")),
            ),
    ):
        result = await stat(
            accessor, _path("/sample_mflix/views/my_view/documents.jsonl"),
            index)
    assert result.type == FileType.TEXT
    assert result.extra["kind"] == "view"
    assert result.extra["indexes"] == []
    assert result.extra["document_count"] == 17


@pytest.mark.asyncio
async def test_stat_schema_json(accessor, index):
    result = await stat(accessor,
                        _path("/sample_mflix/collections/movies/schema.json"),
                        index)
    assert result.type == FileType.TEXT
    assert result.name == "schema.json"
    assert result.extra["kind"] == "collection"
    assert result.extra["name"] == "movies"


@pytest.mark.asyncio
async def test_stat_database_json(accessor, index):
    result = await stat(accessor, _path("/sample_mflix/database.json"), index)
    assert result.type == FileType.TEXT
    assert result.name == "database.json"
    assert result.extra["database"] == "sample_mflix"


@pytest.mark.asyncio
async def test_stat_unknown_path_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, _path("/db/something/extra/leaf"), index)


@pytest.mark.asyncio
async def test_stat_database_missing_raises(accessor, index):
    with patch(
            "mirage.core.mongodb.stat.database_exists",
            new_callable=AsyncMock,
            return_value=False,
    ):
        with pytest.raises(FileNotFoundError):
            await stat(accessor, _path("/ghost"), index)


@pytest.mark.asyncio
async def test_stat_collection_missing_raises(accessor, index):
    with patch(
            "mirage.core.mongodb.stat.entity_exists",
            new_callable=AsyncMock,
            return_value=False,
    ):
        with pytest.raises(FileNotFoundError):
            await stat(accessor, _path("/sample_mflix/collections/ghost"),
                       index)


@pytest.mark.asyncio
async def test_stat_documents_under_missing_collection_raises(accessor, index):
    with patch(
            "mirage.core.mongodb.stat.entity_exists",
            new_callable=AsyncMock,
            return_value=False,
    ):
        with pytest.raises(FileNotFoundError):
            await stat(
                accessor,
                _path("/sample_mflix/collections/ghost/documents.jsonl"),
                index)
