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
from mirage.core.mongodb.readdir import readdir
from mirage.resource.mongodb.config import MongoDBConfig
from mirage.types import PathSpec


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.fixture
def accessor():
    return MongoDBAccessor(config=MongoDBConfig(
        uri="mongodb://localhost:27017"))


def _path(s: str) -> PathSpec:
    return PathSpec(original=s, directory=s)


@pytest.fixture(autouse=True)
def _stub_existence_checks():
    with patch(
            "mirage.core.mongodb.readdir.database_exists",
            new_callable=AsyncMock,
            return_value=True,
    ), patch(
            "mirage.core.mongodb.readdir.entity_exists",
            new_callable=AsyncMock,
            return_value=True,
    ):
        yield


@pytest.mark.asyncio
async def test_readdir_root_lists_databases(accessor, index):
    with patch(
            "mirage.core.mongodb.readdir.list_databases",
            new_callable=AsyncMock,
            return_value=["db1", "db2"],
    ):
        result = await readdir(accessor, _path("/"), index)
    assert "/db1" in result
    assert "/db2" in result


@pytest.mark.asyncio
async def test_readdir_database_returns_fixed_children(accessor, index):
    result = await readdir(accessor, _path("/sample_mflix"), index)
    assert result == [
        "/sample_mflix/database.json",
        "/sample_mflix/collections",
        "/sample_mflix/views",
    ]


@pytest.mark.asyncio
async def test_readdir_collections_dir_lists_collections_only(accessor, index):
    with patch(
            "mirage.core.mongodb.readdir.list_collections",
            new_callable=AsyncMock,
            return_value=["movies", "users"],
    ) as mock_list:
        result = await readdir(accessor, _path("/sample_mflix/collections"),
                               index)
    assert "/sample_mflix/collections/movies" in result
    assert "/sample_mflix/collections/users" in result
    mock_list.assert_awaited_once_with(accessor.client,
                                       "sample_mflix",
                                       kind="collection")


@pytest.mark.asyncio
async def test_readdir_views_dir_lists_views_only(accessor, index):
    with patch(
            "mirage.core.mongodb.readdir.list_collections",
            new_callable=AsyncMock,
            return_value=["top_rated"],
    ) as mock_list:
        result = await readdir(accessor, _path("/sample_mflix/views"), index)
    assert result == ["/sample_mflix/views/top_rated"]
    mock_list.assert_awaited_once_with(accessor.client,
                                       "sample_mflix",
                                       kind="view")


@pytest.mark.asyncio
async def test_readdir_collection_entity_lists_schema_and_documents(
        accessor, index):
    result = await readdir(accessor, _path("/sample_mflix/collections/movies"),
                           index)
    assert result == [
        "/sample_mflix/collections/movies/schema.json",
        "/sample_mflix/collections/movies/documents.jsonl",
    ]


@pytest.mark.asyncio
async def test_readdir_view_entity_lists_schema_and_documents(accessor, index):
    result = await readdir(accessor, _path("/sample_mflix/views/top_rated"),
                           index)
    assert result == [
        "/sample_mflix/views/top_rated/schema.json",
        "/sample_mflix/views/top_rated/documents.jsonl",
    ]


@pytest.mark.asyncio
async def test_readdir_unknown_path_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, _path("/db/something/extra"), index)


@pytest.mark.asyncio
async def test_readdir_root_index_caches_databases(accessor, index):
    mock_list = AsyncMock(return_value=["db1"])
    with patch("mirage.core.mongodb.readdir.list_databases", new=mock_list):
        first = await readdir(accessor, _path("/"), index)
        second = await readdir(accessor, _path("/"), index)
    assert first == second
    assert mock_list.await_count == 1


@pytest.mark.asyncio
async def test_readdir_database_raises_when_db_missing(accessor, index):
    with patch(
            "mirage.core.mongodb.readdir.database_exists",
            new_callable=AsyncMock,
            return_value=False,
    ):
        with pytest.raises(FileNotFoundError):
            await readdir(accessor, _path("/ghost"), index)


@pytest.mark.asyncio
async def test_readdir_entity_raises_when_collection_missing(accessor, index):
    with patch(
            "mirage.core.mongodb.readdir.entity_exists",
            new_callable=AsyncMock,
            return_value=False,
    ):
        with pytest.raises(FileNotFoundError):
            await readdir(accessor, _path("/sample_mflix/collections/ghost"),
                          index)


@pytest.mark.asyncio
async def test_readdir_prefix_carries_through(accessor, index):
    p = PathSpec(original="/mongo/sample_mflix",
                 directory="/mongo/sample_mflix",
                 prefix="/mongo")
    result = await readdir(accessor, p, index)
    assert result == [
        "/mongo/sample_mflix/database.json",
        "/mongo/sample_mflix/collections",
        "/mongo/sample_mflix/views",
    ]
