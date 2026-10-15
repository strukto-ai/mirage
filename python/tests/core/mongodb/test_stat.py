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
from mirage.core.mongodb.stat import stat
from mirage.types import ContentType, FileType, PathSpec
from mirage.vfs.mongodb.config import MongoDBConfig


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
async def test_stat_root(accessor):
    result = await stat(accessor, _path("/"))
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_database(accessor):
    result = await stat(accessor, _path("/sample_mflix"))
    assert result.type == FileType.DIRECTORY
    assert result.name == "sample_mflix"
    assert result.extra["database"] == "sample_mflix"


@pytest.mark.asyncio
async def test_stat_collections_kind_dir(accessor):
    result = await stat(accessor, _path("/sample_mflix/collections"))
    assert result.type == FileType.DIRECTORY
    assert result.name == "collections"
    assert result.extra["kind"] == "collection"


@pytest.mark.asyncio
async def test_stat_views_kind_dir(accessor):
    result = await stat(accessor, _path("/sample_mflix/views"))
    assert result.type == FileType.DIRECTORY
    assert result.name == "views"
    assert result.extra["kind"] == "view"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "suffix,kind",
    [
        ("collections/movies", FileType.DIRECTORY),
        ("collections/movies/documents.jsonl", FileType.FILE),
        ("views/recent/documents.jsonl", FileType.FILE),
    ],
)
async def test_stat_never_counts_or_reads_documents(accessor, suffix, kind):
    with (
        patch(
            "mirage.core.mongodb.client.count_documents",
            new=AsyncMock(side_effect=AssertionError("count scan")),
        ),
        patch(
            "mirage.core.mongodb.client.get_indexes",
            new=AsyncMock(side_effect=AssertionError("index fetch")),
        ),
    ):
        result = await stat(accessor, _path("/sample_mflix/" + suffix))
    assert result.type == kind
    assert result.size is None
    assert "document_count" not in result.extra
    assert "indexes" not in result.extra


@pytest.mark.asyncio
async def test_stat_schema_json(accessor):
    result = await stat(
        accessor, _path("/sample_mflix/collections/movies/schema.json")
    )
    assert result.content == ContentType.TEXT
    assert result.name == "schema.json"
    assert result.extra["kind"] == "collection"
    assert result.extra["name"] == "movies"


@pytest.mark.asyncio
async def test_stat_database_json(accessor):
    result = await stat(accessor, _path("/sample_mflix/database.json"))
    assert result.content == ContentType.TEXT
    assert result.name == "database.json"
    assert result.extra["database"] == "sample_mflix"


@pytest.mark.asyncio
async def test_stat_unknown_path_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, _path("/db/something/extra/leaf"))


@pytest.mark.asyncio
async def test_stat_database_missing_raises(accessor):
    with patch(
        "mirage.core.mongodb.readdir.database_exists",
        new_callable=AsyncMock,
        return_value=False,
    ):
        with pytest.raises(FileNotFoundError):
            await stat(accessor, _path("/ghost"))


@pytest.mark.asyncio
async def test_stat_collection_missing_raises(accessor):
    with patch(
        "mirage.core.mongodb.readdir.entity_exists",
        new_callable=AsyncMock,
        return_value=False,
    ):
        with pytest.raises(FileNotFoundError):
            await stat(accessor, _path("/sample_mflix/collections/ghost"))


@pytest.mark.asyncio
async def test_stat_documents_under_missing_collection_raises(accessor):
    with patch(
        "mirage.core.mongodb.readdir.entity_exists",
        new_callable=AsyncMock,
        return_value=False,
    ):
        with pytest.raises(FileNotFoundError):
            await stat(
                accessor,
                _path("/sample_mflix/collections/ghost/documents.jsonl"),
            )
