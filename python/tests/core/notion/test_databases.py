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
from unittest.mock import AsyncMock

import pytest

from mirage.accessor.notion import NotionAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.notion import read as notion_read
from mirage.core.notion import readdir as notion_readdir
from mirage.core.notion import stat as notion_stat
from mirage.core.notion.config import NotionConfig
from mirage.core.notion.normalize import normalize_database, to_json_bytes
from mirage.core.notion.read import read
from mirage.core.notion.readdir import readdir
from mirage.core.notion.stat import stat
from mirage.types import FileType, PathSpec

DATABASE_ID = "db123"
SOURCE_ID = "ds789"
ROW_ID = "row456"
DB_DIR = f"/databases/Tasks__{DATABASE_ID}"
SOURCE_DIR = f"{DB_DIR}/Tasks__{SOURCE_ID}"

DATABASE = {
    "id": DATABASE_ID,
    "title": [{
        "plain_text": "Tasks"
    }],
    "url": "https://notion.test/db123",
    "created_time": "2026-01-01T00:00:00Z",
    "last_edited_time": "2026-01-02T00:00:00Z",
    "parent": {
        "type": "workspace"
    },
    "data_sources": [{
        "id": SOURCE_ID,
        "name": "Tasks"
    }],
}

DATA_SOURCE = {
    "id": SOURCE_ID,
    "title": [{
        "plain_text": "Tasks"
    }],
    "parent": {
        "type": "database_id",
        "database_id": DATABASE_ID
    },
    "properties": {
        "Name": {
            "type": "title"
        }
    },
}


@pytest.fixture
def accessor():
    return NotionAccessor(NotionConfig(api_key="ntn_test"))


@pytest.mark.asyncio
async def test_readdir_root_includes_pages_and_databases(accessor):
    entries = await readdir(accessor, PathSpec.from_str_path("/"))
    assert entries == ["/pages", "/databases"]


@pytest.mark.asyncio
async def test_readdir_databases_lists_database_directories(
        accessor, monkeypatch):
    # Search answers with data sources since 2025-09-03, so the set of
    # databases is their distinct parents, each retrieved for its title.
    monkeypatch.setattr(
        notion_readdir,
        "search_data_sources",
        AsyncMock(return_value=[{
            "id": SOURCE_ID,
            "object": "data_source",
            "parent": {
                "type": "database_id",
                "database_id": DATABASE_ID
            },
        }]),
    )
    monkeypatch.setattr(notion_readdir, "get_database",
                        AsyncMock(return_value=DATABASE))
    entries = await readdir(accessor, PathSpec.from_str_path("/databases"),
                            RAMIndexCacheStore())
    assert entries == [DB_DIR]


@pytest.mark.asyncio
async def test_readdir_database_dir_lists_its_data_sources(
        accessor, monkeypatch):
    monkeypatch.setattr(notion_readdir, "get_database",
                        AsyncMock(return_value=DATABASE))
    entries = await readdir(accessor, PathSpec.from_str_path(DB_DIR))
    assert entries == [f"{DB_DIR}/database.json", SOURCE_DIR]


@pytest.mark.asyncio
async def test_readdir_database_dir_sizes_database_json_from_the_database(
        accessor, monkeypatch):
    monkeypatch.setattr(
        notion_readdir,
        "search_data_sources",
        AsyncMock(return_value=[{
            "id": SOURCE_ID,
            "parent": {
                "type": "database_id",
                "database_id": DATABASE_ID
            },
        }]),
    )
    monkeypatch.setattr(notion_readdir, "get_database",
                        AsyncMock(return_value=DATABASE))
    index = RAMIndexCacheStore()
    await readdir(accessor, PathSpec.from_str_path("/databases"), index)
    await readdir(accessor, PathSpec.from_str_path(DB_DIR), index)
    lookup = await index.get(f"{DB_DIR}/database.json")
    assert lookup.entry is not None
    expected = to_json_bytes(normalize_database(DATABASE))
    assert lookup.entry.size == len(expected)
    result = await stat(accessor,
                        PathSpec.from_str_path(f"{DB_DIR}/database.json"),
                        index)
    assert result.size == len(expected)


@pytest.mark.asyncio
async def test_readdir_data_source_lists_row_pages(accessor, monkeypatch):
    monkeypatch.setattr(notion_readdir, "get_data_source",
                        AsyncMock(return_value=DATA_SOURCE))
    monkeypatch.setattr(
        notion_readdir,
        "query_data_source",
        AsyncMock(return_value=[{
            "object": "page",
            "id": ROW_ID,
            "properties": {
                "Name": {
                    "type": "title",
                    "title": [{
                        "plain_text": "Row A"
                    }],
                }
            },
            "last_edited_time": "2026-01-02T00:00:00Z",
        }]),
    )
    entries = await readdir(accessor, PathSpec.from_str_path(SOURCE_DIR))
    assert entries == [
        f"{SOURCE_DIR}/data_source.json",
        f"{SOURCE_DIR}/Row_A__{ROW_ID}",
    ]


@pytest.mark.asyncio
async def test_read_database_json_is_a_container_without_a_schema(
        accessor, monkeypatch):
    monkeypatch.setattr(notion_read, "get_database",
                        AsyncMock(return_value=DATABASE))
    data = await read(accessor,
                      PathSpec.from_str_path(f"{DB_DIR}/database.json"))
    decoded = json.loads(data)
    assert decoded["database_id"] == DATABASE_ID
    assert decoded["title"] == "Tasks"
    assert decoded["data_sources"] == [{"id": SOURCE_ID, "name": "Tasks"}]
    # The schema moved to the data source at 2025-09-03 and must not be
    # synthesized back onto the container.
    assert "properties" not in decoded
    assert "rows" not in decoded
    assert "row_count" not in decoded


@pytest.mark.asyncio
async def test_read_data_source_json_carries_the_schema(accessor, monkeypatch):
    monkeypatch.setattr(notion_read, "get_data_source",
                        AsyncMock(return_value=DATA_SOURCE))
    data = await read(accessor,
                      PathSpec.from_str_path(f"{SOURCE_DIR}/data_source.json"))
    decoded = json.loads(data)
    assert decoded["data_source_id"] == SOURCE_ID
    assert decoded["database_id"] == DATABASE_ID
    assert decoded["properties"] == {"Name": {"type": "title"}}


@pytest.mark.asyncio
async def test_readdir_database_row_lists_page_json_and_child_pages(
    accessor,
    monkeypatch,
):
    monkeypatch.setattr(
        notion_readdir,
        "list_block_children",
        AsyncMock(return_value=[{
            "id": "child789",
            "type": "child_page",
            "child_page": {
                "title": "Child"
            },
        }]),
    )
    entries = await readdir(
        accessor, PathSpec.from_str_path(f"{SOURCE_DIR}/Row-A__{ROW_ID}"))
    assert entries == [
        f"{SOURCE_DIR}/Row-A__{ROW_ID}/page.json",
        f"{SOURCE_DIR}/Row-A__{ROW_ID}/Child__child789",
    ]


@pytest.mark.asyncio
async def test_stat_database_dir_uses_database_metadata(accessor, monkeypatch):
    monkeypatch.setattr(
        notion_stat,
        "get_database",
        AsyncMock(return_value={"last_edited_time": "2026-01-03T00:00:00Z"}),
    )
    result = await stat(accessor, PathSpec.from_str_path(DB_DIR))
    assert result.name == f"Tasks__{DATABASE_ID}"
    assert result.type == FileType.DIRECTORY
    assert result.modified == "2026-01-03T00:00:00Z"
    assert result.extra == {"database_id": DATABASE_ID}


@pytest.mark.asyncio
async def test_stat_data_source_dir(accessor, monkeypatch):
    monkeypatch.setattr(notion_stat, "get_data_source",
                        AsyncMock(return_value=DATA_SOURCE))
    result = await stat(accessor, PathSpec.from_str_path(SOURCE_DIR))
    assert result.name == f"Tasks__{SOURCE_ID}"
    assert result.type == FileType.DIRECTORY
    assert result.extra == {"data_source_id": SOURCE_ID}


@pytest.mark.asyncio
async def test_stat_database_row_dir(accessor):
    result = await stat(
        accessor, PathSpec.from_str_path(f"{SOURCE_DIR}/Row-A__{ROW_ID}"))
    assert result.name == f"Row-A__{ROW_ID}"
    assert result.type == FileType.DIRECTORY
    assert result.extra == {"page_id": ROW_ID}
