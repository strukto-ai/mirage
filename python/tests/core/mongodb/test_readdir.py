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
from mirage.core.mongodb.readdir import readdir
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.mongodb.config import MongoDBConfig


def _names(rows):
    return [row.name for row in rows]


@pytest.fixture
def accessor():
    return MongoDBAccessor(
        config=MongoDBConfig(uri="mongodb://localhost:27017")
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
async def test_readdir_root_lists_databases(accessor):
    with patch(
        "mirage.core.mongodb.readdir.list_databases",
        new_callable=AsyncMock,
        return_value=["db1", "db2"],
    ):
        result = await readdir(accessor, _path("/"))
    assert "db1" in _names(result)
    assert "db2" in _names(result)


@pytest.mark.asyncio
async def test_readdir_database_returns_fixed_children(accessor):
    result = await readdir(accessor, _path("/sample_mflix"))
    assert _names(result) == ["database.json", "collections", "views"]


@pytest.mark.asyncio
async def test_readdir_collections_dir_lists_collections_only(accessor):
    with patch(
        "mirage.core.mongodb.readdir.list_collections",
        new_callable=AsyncMock,
        return_value=["movies", "users"],
    ) as mock_list:
        result = await readdir(accessor, _path("/sample_mflix/collections"))
    assert _names(result) == ["movies", "users"]
    assert result[0].type is FileType.DIRECTORY
    assert result[0].extra == {
        "database": "sample_mflix",
        "kind": "collection",
        "name": "movies",
    }
    mock_list.assert_awaited_once_with(
        accessor.client, "sample_mflix", kind="collection"
    )


@pytest.mark.asyncio
async def test_readdir_views_dir_lists_views_only(accessor):
    with patch(
        "mirage.core.mongodb.readdir.list_collections",
        new_callable=AsyncMock,
        return_value=["top_rated"],
    ) as mock_list:
        result = await readdir(accessor, _path("/sample_mflix/views"))
    assert _names(result) == ["top_rated"]
    mock_list.assert_awaited_once_with(
        accessor.client, "sample_mflix", kind="view"
    )


@pytest.mark.asyncio
async def test_readdir_collection_entity_lists_schema_and_documents(accessor):
    result = await readdir(accessor, _path("/sample_mflix/collections/movies"))
    assert _names(result) == ["schema.json", "documents.jsonl"]


@pytest.mark.asyncio
async def test_readdir_view_entity_lists_schema_and_documents(accessor):
    result = await readdir(accessor, _path("/sample_mflix/views/top_rated"))
    assert _names(result) == ["schema.json", "documents.jsonl"]


@pytest.mark.asyncio
async def test_readdir_unknown_path_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, _path("/db/something/extra"))


@pytest.mark.asyncio
async def test_readdir_database_raises_when_db_missing(accessor):
    with patch(
        "mirage.core.mongodb.readdir.database_exists",
        new_callable=AsyncMock,
        return_value=False,
    ):
        with pytest.raises(FileNotFoundError):
            await readdir(accessor, _path("/ghost"))


@pytest.mark.asyncio
async def test_readdir_entity_raises_when_collection_missing(accessor):
    with patch(
        "mirage.core.mongodb.readdir.entity_exists",
        new_callable=AsyncMock,
        return_value=False,
    ):
        with pytest.raises(FileNotFoundError):
            await readdir(accessor, _path("/sample_mflix/collections/ghost"))


@pytest.mark.asyncio
async def test_readdir_prefix_carries_through(accessor):
    p = PathSpec(
        vfs_path=mount_key("/mongo/sample_mflix", "/mongo"),
        virtual="/mongo/sample_mflix",
        directory="/mongo/sample_mflix",
    )
    result = await readdir(accessor, p)
    assert _names(result) == ["database.json", "collections", "views"]
