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

from unittest.mock import AsyncMock

import pytest

from mirage.accessor.notion import NotionAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.notion import read as notion_read
from mirage.core.notion import readdir as notion_readdir
from mirage.core.notion import stat as notion_stat
from mirage.core.notion.read import read
from mirage.core.notion.readdir import readdir
from mirage.core.notion.stat import stat
from mirage.resource.notion.config import NotionConfig
from mirage.types import FileType, PathSpec

DATABASE_ID = "db123"
ROW_ID = "row456"


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
    monkeypatch.setattr(
        notion_readdir,
        "search_databases",
        AsyncMock(return_value=[{
            "id": DATABASE_ID,
            "title": [{
                "plain_text": "Tasks"
            }],
            "last_edited_time": "2026-01-01T00:00:00Z",
        }]),
    )
    entries = await readdir(accessor, PathSpec.from_str_path("/databases"),
                            RAMIndexCacheStore())
    assert entries == [f"/databases/Tasks__{DATABASE_ID}"]


@pytest.mark.asyncio
async def test_readdir_database_lists_row_pages(accessor, monkeypatch):
    monkeypatch.setattr(
        notion_readdir,
        "query_database",
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
    entries = await readdir(
        accessor, PathSpec.from_str_path(f"/databases/Tasks__{DATABASE_ID}"))
    assert entries == [
        f"/databases/Tasks__{DATABASE_ID}/database.json",
        f"/databases/Tasks__{DATABASE_ID}/Row_A__{ROW_ID}",
    ]


@pytest.mark.asyncio
async def test_read_database_json_returns_database_metadata(
        accessor, monkeypatch):
    monkeypatch.setattr(
        notion_read,
        "get_database",
        AsyncMock(
            return_value={
                "id": DATABASE_ID,
                "title": [{
                    "plain_text": "Tasks"
                }],
                "properties": {
                    "Name": {
                        "type": "title"
                    }
                },
                "last_edited_time": "2026-01-03T00:00:00Z",
            }),
    )
    data = await read(
        accessor,
        PathSpec.from_str_path(
            f"/databases/Tasks__{DATABASE_ID}/database.json"))
    import json

    decoded = json.loads(data)
    assert decoded["database_id"] == DATABASE_ID
    assert decoded["title"] == "Tasks"
    assert decoded["properties"] == {"Name": {"type": "title"}}
    assert "rows" not in decoded
    assert "row_count" not in decoded


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
        accessor,
        PathSpec.from_str_path(
            f"/databases/Tasks__{DATABASE_ID}/Row-A__{ROW_ID}"))
    assert entries == [
        f"/databases/Tasks__{DATABASE_ID}/Row-A__{ROW_ID}/page.json",
        f"/databases/Tasks__{DATABASE_ID}/Row-A__{ROW_ID}/Child__child789",
    ]


@pytest.mark.asyncio
async def test_stat_database_dir_uses_database_metadata(accessor, monkeypatch):
    monkeypatch.setattr(
        notion_stat,
        "get_database",
        AsyncMock(return_value={"last_edited_time": "2026-01-03T00:00:00Z"}),
    )
    result = await stat(
        accessor, PathSpec.from_str_path(f"/databases/Tasks__{DATABASE_ID}"))
    assert result.name == f"Tasks__{DATABASE_ID}"
    assert result.type == FileType.DIRECTORY
    assert result.modified == "2026-01-03T00:00:00Z"
    assert result.extra == {"database_id": DATABASE_ID}


@pytest.mark.asyncio
async def test_stat_database_row_dir(accessor):
    result = await stat(
        accessor,
        PathSpec.from_str_path(
            f"/databases/Tasks__{DATABASE_ID}/Row-A__{ROW_ID}"),
    )
    assert result.name == f"Row-A__{ROW_ID}"
    assert result.type == FileType.DIRECTORY
    assert result.extra == {"page_id": ROW_ID}
