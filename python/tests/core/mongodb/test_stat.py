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
    config = MongoDBConfig(uri="mongodb://localhost:27017")
    return MongoDBAccessor(config=config)


@pytest.fixture
def single_db_accessor():
    config = MongoDBConfig(uri="mongodb://localhost:27017", databases=["mydb"])
    return MongoDBAccessor(config=config)


@pytest.mark.asyncio
async def test_stat_root(accessor, index):
    result = await stat(accessor, PathSpec(original="/", directory="/"), index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_database(accessor, index):
    result = await stat(
        accessor, PathSpec(original="/sample_mflix",
                           directory="/sample_mflix"), index)
    assert result.type == FileType.DIRECTORY
    assert result.extra["database"] == "sample_mflix"


@pytest.mark.asyncio
async def test_stat_collection_file(accessor, index):
    fake_indexes = [{"name": "_id_", "key": {"_id": 1}}]
    with (
            patch(
                "mirage.core.mongodb.stat.is_view",
                new_callable=AsyncMock,
                return_value=False,
            ),
            patch(
                "mirage.core.mongodb.stat.count_documents",
                new_callable=AsyncMock,
                return_value=42,
            ),
            patch(
                "mirage.core.mongodb.stat.get_indexes",
                new_callable=AsyncMock,
                return_value=fake_indexes,
            ),
    ):
        result = await stat(
            accessor,
            PathSpec(original="/sample_mflix/movies.jsonl",
                     directory="/sample_mflix/movies.jsonl"), index)

    assert result.type == FileType.TEXT
    assert result.name == "movies.jsonl"
    assert result.extra["database"] == "sample_mflix"
    assert result.extra["collection"] == "movies"
    assert result.extra["document_count"] == 42
    assert result.extra["indexes"] == [{"name": "_id_", "keys": {"_id": 1}}]


@pytest.mark.asyncio
async def test_stat_single_db_collection(single_db_accessor, index):
    with (
            patch(
                "mirage.core.mongodb.stat.is_view",
                new_callable=AsyncMock,
                return_value=False,
            ),
            patch(
                "mirage.core.mongodb.stat.count_documents",
                new_callable=AsyncMock,
                return_value=10,
            ),
            patch(
                "mirage.core.mongodb.stat.get_indexes",
                new_callable=AsyncMock,
                return_value=[],
            ),
    ):
        result = await stat(
            single_db_accessor,
            PathSpec(original="/movies.jsonl", directory="/movies.jsonl"),
            index)

    assert result.type == FileType.TEXT
    assert result.extra["database"] == "mydb"
    assert result.extra["collection"] == "movies"


@pytest.mark.asyncio
async def test_stat_view_skips_indexes(accessor, index):
    with (
            patch(
                "mirage.core.mongodb.stat.is_view",
                new_callable=AsyncMock,
                return_value=True,
            ),
            patch(
                "mirage.core.mongodb.stat.count_documents",
                new_callable=AsyncMock,
                return_value=17,
            ),
            patch(
                "mirage.core.mongodb.stat.get_indexes",
                new_callable=AsyncMock,
                side_effect=AssertionError(
                    "get_indexes should not be called on a view"),
            ),
    ):
        result = await stat(
            accessor,
            PathSpec(original="/sample_mflix/my_view.jsonl",
                     directory="/sample_mflix/my_view.jsonl"), index)
    assert result.type == FileType.TEXT
    assert result.name == "my_view.jsonl"
    assert result.extra["database"] == "sample_mflix"
    assert result.extra["collection"] == "my_view"
    assert result.extra["document_count"] == 17
    assert result.extra["indexes"] == []
    assert result.extra["kind"] == "view"


@pytest.mark.asyncio
async def test_stat_collection_marks_kind(accessor, index):
    fake_indexes = [{"name": "_id_", "key": {"_id": 1}}]
    with (
            patch(
                "mirage.core.mongodb.stat.is_view",
                new_callable=AsyncMock,
                return_value=False,
            ),
            patch(
                "mirage.core.mongodb.stat.count_documents",
                new_callable=AsyncMock,
                return_value=5,
            ),
            patch(
                "mirage.core.mongodb.stat.get_indexes",
                new_callable=AsyncMock,
                return_value=fake_indexes,
            ),
    ):
        result = await stat(
            accessor,
            PathSpec(original="/sample_mflix/movies.jsonl",
                     directory="/sample_mflix/movies.jsonl"), index)
    assert result.extra["kind"] == "collection"
    assert result.extra["indexes"] == [{"name": "_id_", "keys": {"_id": 1}}]


@pytest.mark.asyncio
async def test_stat_not_found(accessor, index):
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            PathSpec(original="/db/col/extra/path",
                     directory="/db/col/extra/path"), index)
