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
from mirage.core.notion import read as notion_read
from mirage.core.notion import readdir as notion_readdir
from mirage.core.notion import resolve as notion_resolve
from mirage.core.notion.client import NotionAPIError
from mirage.core.notion.config import NotionConfig
from mirage.core.notion.normalize import normalize_database, to_json_bytes
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.vfs.notion import NotionVFS
from tests.fixtures.mounted import Mounted

DATABASE_ID = "db123"
SOURCE_ID = "ds789"
ROW_ID = "row456"
DB_DIR = f"/databases/Tasks__{DATABASE_ID}"
SOURCE_DIR = f"{DB_DIR}/Tasks__{SOURCE_ID}"

DATABASE = {
    "id": DATABASE_ID,
    "title": [{"plain_text": "Tasks"}],
    "url": "https://notion.test/db123",
    "created_time": "2026-01-01T00:00:00Z",
    "last_edited_time": "2026-01-02T00:00:00Z",
    "parent": {"type": "workspace"},
    "data_sources": [{"id": SOURCE_ID, "name": "Tasks"}],
}

DATA_SOURCE = {
    "id": SOURCE_ID,
    "title": [{"plain_text": "Tasks"}],
    "parent": {"type": "database_id", "database_id": DATABASE_ID},
    "properties": {"Name": {"type": "title"}},
}


async def readdir(accessor: NotionAccessor, path: PathSpec, *_) -> list[str]:
    return await Mounted(NotionVFS, accessor).readdir(path)


async def stat(accessor: NotionAccessor, path: PathSpec, *_) -> FileStat:
    return await Mounted(NotionVFS, accessor).stat(path)


async def read(accessor: NotionAccessor, path: PathSpec, *_) -> bytes:
    return await Mounted(NotionVFS, accessor).read(path)


@pytest.fixture
def accessor(monkeypatch):
    monkeypatch.setattr(
        notion_readdir,
        "search_data_sources",
        AsyncMock(return_value=[DATA_SOURCE]),
    )
    monkeypatch.setattr(
        notion_readdir, "get_database", AsyncMock(return_value=DATABASE)
    )
    monkeypatch.setattr(
        notion_readdir, "get_data_source", AsyncMock(return_value=DATA_SOURCE)
    )
    return NotionAccessor(NotionConfig(api_key="ntn_test"))


@pytest.mark.asyncio
async def test_readdir_root_includes_pages_and_databases(accessor):
    entries = await readdir(accessor, PathSpec.from_str_path("/"))
    assert entries == ["/pages", "/databases"]


@pytest.mark.asyncio
async def test_readdir_databases_lists_database_directories(
    accessor, monkeypatch
):
    # Search answers with data sources since 2025-09-03, so the set of
    # databases is their distinct parents, each retrieved for its title.
    monkeypatch.setattr(
        notion_readdir,
        "search_data_sources",
        AsyncMock(
            return_value=[
                {
                    "id": SOURCE_ID,
                    "object": "data_source",
                    "parent": {
                        "type": "database_id",
                        "database_id": DATABASE_ID,
                    },
                }
            ]
        ),
    )
    monkeypatch.setattr(
        notion_readdir, "get_database", AsyncMock(return_value=DATABASE)
    )
    entries = await readdir(accessor, PathSpec.from_str_path("/databases"))
    assert entries == [DB_DIR]


@pytest.mark.asyncio
async def test_readdir_database_dir_lists_its_data_sources(
    accessor, monkeypatch
):
    monkeypatch.setattr(
        notion_readdir, "get_database", AsyncMock(return_value=DATABASE)
    )
    entries = await readdir(accessor, PathSpec.from_str_path(DB_DIR))
    assert entries == [f"{DB_DIR}/database.json", SOURCE_DIR]


@pytest.mark.asyncio
async def test_readdir_database_dir_sizes_database_json_from_the_database(
    accessor, monkeypatch
):
    monkeypatch.setattr(
        notion_readdir,
        "search_data_sources",
        AsyncMock(
            return_value=[
                {
                    "id": SOURCE_ID,
                    "parent": {
                        "type": "database_id",
                        "database_id": DATABASE_ID,
                    },
                }
            ]
        ),
    )
    monkeypatch.setattr(
        notion_readdir, "get_database", AsyncMock(return_value=DATABASE)
    )
    mounted = Mounted(NotionVFS, accessor)
    await mounted.readdir("/databases")
    await mounted.readdir(DB_DIR)
    expected = to_json_bytes(normalize_database(DATABASE))
    result = await mounted.stat(f"{DB_DIR}/database.json")
    assert result.size == len(expected)


@pytest.mark.asyncio
async def test_readdir_data_source_lists_the_schema_and_rows_jsonl(
    accessor, monkeypatch
):
    get_data_source = AsyncMock(return_value=DATA_SOURCE)
    monkeypatch.setattr(notion_readdir, "get_data_source", get_data_source)
    entries = await readdir(accessor, PathSpec.from_str_path(SOURCE_DIR))
    assert entries == [
        f"{SOURCE_DIR}/data_source.json",
        f"{SOURCE_DIR}/rows.jsonl",
    ]
    get_data_source.assert_awaited_once()


@pytest.mark.asyncio
async def test_read_database_json_is_a_container_without_a_schema(
    accessor, monkeypatch
):
    monkeypatch.setattr(
        notion_read, "get_database", AsyncMock(return_value=DATABASE)
    )
    data = await read(
        accessor, PathSpec.from_str_path(f"{DB_DIR}/database.json")
    )
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
    monkeypatch.setattr(
        notion_read, "get_data_source", AsyncMock(return_value=DATA_SOURCE)
    )
    data = await read(
        accessor, PathSpec.from_str_path(f"{SOURCE_DIR}/data_source.json")
    )
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
        AsyncMock(
            return_value=[
                {
                    "id": "child789",
                    "type": "child_page",
                    "child_page": {"title": "Child"},
                }
            ]
        ),
    )
    monkeypatch.setattr(
        notion_resolve, "get_page", AsyncMock(return_value=_row())
    )
    entries = await readdir(
        accessor, PathSpec.from_str_path(f"{SOURCE_DIR}/Row-A__{ROW_ID}")
    )
    assert entries == [
        f"{SOURCE_DIR}/Row-A__{ROW_ID}/page.json",
        f"{SOURCE_DIR}/Row-A__{ROW_ID}/Child__child789",
    ]


@pytest.mark.asyncio
async def test_stat_database_dir_resolves_through_the_listing(
    accessor, monkeypatch
):
    monkeypatch.setattr(
        notion_readdir,
        "search_data_sources",
        AsyncMock(
            return_value=[
                {
                    "id": SOURCE_ID,
                    "parent": {
                        "type": "database_id",
                        "database_id": DATABASE_ID,
                    },
                }
            ]
        ),
    )
    monkeypatch.setattr(
        notion_readdir, "get_database", AsyncMock(return_value=DATABASE)
    )
    result = await stat(accessor, PathSpec.from_str_path(DB_DIR))
    assert result.name == f"Tasks__{DATABASE_ID}"
    assert result.type == FileType.DIRECTORY
    assert result.modified == "2026-01-02T00:00:00Z"
    assert result.extra == {"database_id": DATABASE_ID}


@pytest.mark.asyncio
async def test_stat_data_source_dir(accessor, monkeypatch):
    monkeypatch.setattr(
        notion_readdir, "get_database", AsyncMock(return_value=DATABASE)
    )
    result = await stat(accessor, PathSpec.from_str_path(SOURCE_DIR))
    assert result.name == f"Tasks__{SOURCE_ID}"
    assert result.type == FileType.DIRECTORY
    assert result.extra == {"data_source_id": SOURCE_ID}


def _row(**overrides):
    return {
        "object": "page",
        "id": ROW_ID,
        "url": "https://notion.test/row456",
        "created_time": "2026-01-01T00:00:00Z",
        "last_edited_time": "2026-01-02T00:00:00Z",
        "in_trash": False,
        "parent": {
            "type": "data_source_id",
            "data_source_id": SOURCE_ID,
            "database_id": DATABASE_ID,
        },
        "properties": {
            "Name": {
                "type": "title",
                "title": [{"plain_text": "Row-A"}],
            },
            "Priority": {"type": "number", "number": 2},
        },
        **overrides,
    }


@pytest.mark.asyncio
async def test_read_rows_jsonl_is_one_line_per_row(accessor, monkeypatch):
    query = AsyncMock(return_value=[_row(), {"object": "database", "id": "x"}])
    monkeypatch.setattr(notion_read, "query_data_source", query)
    data = await read(
        accessor, PathSpec.from_str_path(f"{SOURCE_DIR}/rows.jsonl")
    )
    lines = data.decode().split("\n")
    assert len(lines) == 2
    assert lines[1] == ""
    decoded = json.loads(lines[0])
    assert list(decoded) == [
        "page_id",
        "title",
        "path",
        "url",
        "created_time",
        "last_edited_time",
        "parent_type",
        "parent_id",
        "archived",
        "created_by",
        "last_edited_by",
        "properties",
    ]
    assert decoded["path"] == f"Row-A__{ROW_ID}/page.json"
    assert decoded["parent_id"] == SOURCE_ID
    assert decoded["properties"] == _row()["properties"]
    assert query.await_args.args[1] == SOURCE_ID


@pytest.mark.asyncio
async def test_read_rows_jsonl_of_no_rows_is_empty(accessor, monkeypatch):
    monkeypatch.setattr(
        notion_read, "query_data_source", AsyncMock(return_value=[])
    )
    data = await read(
        accessor, PathSpec.from_str_path(f"{SOURCE_DIR}/rows.jsonl")
    )
    assert data == b""


@pytest.mark.asyncio
async def test_stat_database_row_dir(accessor, monkeypatch):
    get_page = AsyncMock(return_value=_row())
    monkeypatch.setattr(notion_resolve, "get_page", get_page)
    result = await stat(
        accessor,
        PathSpec.from_str_path(f"{SOURCE_DIR}/Row-A__{ROW_ID}"),
    )
    assert result.name == f"Row-A__{ROW_ID}"
    assert result.type == FileType.DIRECTORY
    assert result.modified == "2026-01-02T00:00:00Z"
    assert result.extra == {"page_id": ROW_ID}
    get_page.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "page,segment",
    [
        (
            _row(parent={"type": "data_source_id", "data_source_id": "other"}),
            f"Row-A__{ROW_ID}",
        ),
        (_row(), f"Row-B__{ROW_ID}"),
        (_row(in_trash=True), f"Row-A__{ROW_ID}"),
    ],
)
async def test_stat_database_row_dir_that_is_not_this_row(
    accessor, monkeypatch, page, segment
):
    monkeypatch.setattr(
        notion_resolve, "get_page", AsyncMock(return_value=page)
    )
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            PathSpec.from_str_path(f"{SOURCE_DIR}/{segment}"),
        )


@pytest.mark.asyncio
async def test_stat_database_row_dir_notion_does_not_know(
    accessor, monkeypatch
):
    monkeypatch.setattr(
        notion_resolve,
        "get_page",
        AsyncMock(
            side_effect=NotionAPIError(
                "Could not find page", status=404, code="object_not_found"
            )
        ),
    )
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            PathSpec.from_str_path(f"{SOURCE_DIR}/Row-A__{ROW_ID}"),
        )


@pytest.mark.asyncio
async def test_stat_rows_jsonl_through_the_data_source_listing(
    accessor, monkeypatch
):
    monkeypatch.setattr(
        notion_readdir, "get_data_source", AsyncMock(return_value=DATA_SOURCE)
    )
    result = await stat(
        accessor,
        PathSpec.from_str_path(f"{SOURCE_DIR}/rows.jsonl"),
    )
    assert result.type == FileType.FILE
    assert result.content == ContentType.TEXT
    assert result.size is None
    assert result.extra == {"data_source_id": SOURCE_ID}


@pytest.mark.asyncio
async def test_stat_row_page_json_without_fetching_blocks(
    accessor, monkeypatch
):
    monkeypatch.setattr(
        notion_resolve, "get_page", AsyncMock(return_value=_row())
    )
    monkeypatch.setattr(
        notion_readdir, "list_block_children", AsyncMock(return_value=[])
    )
    result = await stat(
        accessor,
        PathSpec.from_str_path(f"{SOURCE_DIR}/Row-A__{ROW_ID}/page.json"),
    )
    assert result.type == FileType.FILE
    assert result.content == ContentType.JSON


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "number,spelling",
    [
        (100000000000000000000, "100000000000000000000"),
        (1e-5, "0.00001"),
        (1e-7, "1e-7"),
        (1.0, "1"),
        (-0.0, "0"),
    ],
)
async def test_rows_jsonl_spells_numeric_cells(
    accessor, monkeypatch, number, spelling
):
    row = _row()
    row["properties"]["Priority"]["number"] = number
    monkeypatch.setattr(
        notion_read, "query_data_source", AsyncMock(return_value=[row])
    )
    data = await read(
        accessor, PathSpec.from_str_path(f"{SOURCE_DIR}/rows.jsonl")
    )
    assert json.loads(data)["properties"]["Priority"]["number"] == number
    assert f'"number":{spelling}}}'.encode() in data


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "directory",
    [
        "/databases/Wrong__db123",
        "/databases/Tasks__db123/Wrong__ds789",
        "/databases/Tasks__db123/Other__foreign",
    ],
)
@pytest.mark.parametrize("operation", [read, readdir, stat])
async def test_paths_must_be_listed_by_their_parent(
    accessor, directory, operation
):
    suffix = "/database.json" if directory.count("/") == 2 else "/rows.jsonl"
    path = directory + suffix if operation is read else directory
    with pytest.raises(FileNotFoundError):
        await operation(accessor, PathSpec.from_str_path(path))
