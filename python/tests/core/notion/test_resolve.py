from unittest.mock import AsyncMock

import pytest

from mirage.accessor.notion import NotionAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.notion import read as notion_read
from mirage.core.notion import readdir as notion_readdir
from mirage.core.notion import resolve as notion_resolve
from mirage.core.notion.config import NotionConfig
from mirage.core.notion.read import read
from mirage.core.notion.readdir import readdir
from mirage.core.notion.stat import stat
from mirage.types import PathSpec


@pytest.fixture(autouse=True)
def parent_hierarchy(monkeypatch):
    monkeypatch.setattr(
        notion_readdir,
        "search_data_sources",
        AsyncMock(return_value=[{"parent": {"database_id": "db"}}]),
    )
    monkeypatch.setattr(
        notion_readdir,
        "get_database",
        AsyncMock(
            return_value={
                "id": "db",
                "title": [{"plain_text": "DB"}],
                "data_sources": [{"id": "ds", "name": "DS"}],
            }
        ),
    )
    monkeypatch.setattr(
        notion_readdir, "get_data_source", AsyncMock(return_value={"id": "ds"})
    )
    monkeypatch.setattr(
        notion_readdir,
        "list_block_children",
        AsyncMock(
            return_value=[
                {
                    "id": "child",
                    "type": "child_page",
                    "child_page": {"title": "Child"},
                }
            ]
        ),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operation,suffix",
    [
        (stat, ""),
        (stat, "/page.json"),
        (readdir, ""),
        (read, "/page.json"),
        (stat, "/Child__child"),
        (read, "/Child__child/page.json"),
        (readdir, "/Child__child"),
    ],
)
@pytest.mark.parametrize("change", ["title", "parent", "trash", "archived"])
async def test_row_validation_applies_to_every_entry_point(
    monkeypatch, operation, suffix, change
):
    page = {
        "id": "row",
        "properties": {
            "Name": {"type": "title", "title": [{"plain_text": "Row"}]}
        },
        "parent": {"data_source_id": "ds"},
    }
    if change == "parent":
        page["parent"]["data_source_id"] = "other"
    elif change == "trash":
        page["in_trash"] = True
    elif change == "archived":
        page["archived"] = True
    label = "Wrong" if change == "title" else "Row"
    fetch = AsyncMock(return_value=page)
    monkeypatch.setattr(notion_resolve, "get_page", fetch)
    accessor = NotionAccessor(NotionConfig(api_key="test"))
    path = PathSpec.from_str_path(
        f"/databases/DB__db/DS__ds/{label}__row{suffix}"
    )
    index = RAMIndexCacheStore()
    await index.set_dir(path.virtual, [])
    with pytest.raises(FileNotFoundError):
        await operation(accessor, path, index)
    assert fetch.await_count >= 1


@pytest.mark.asyncio
async def test_read_child_keeps_the_containing_row_identity(monkeypatch):
    row = {
        "id": "row",
        "parent": {"data_source_id": "ds"},
        "properties": {
            "Name": {"type": "title", "title": [{"plain_text": "Row"}]}
        },
    }
    fetch_row = AsyncMock(return_value=row)
    fetch_child = AsyncMock(return_value={"id": "child"})
    monkeypatch.setattr(notion_resolve, "get_page", fetch_row)
    monkeypatch.setattr(notion_read, "get_page", fetch_child)
    monkeypatch.setattr(
        notion_read, "list_block_tree", AsyncMock(return_value=[])
    )
    accessor = NotionAccessor(NotionConfig(api_key="test"))
    path = PathSpec.from_str_path(
        "/databases/DB__db/DS__ds/Row__row/Child__child/page.json"
    )
    await read(accessor, path)
    assert fetch_row.await_args.args[1] == "row"
    assert fetch_child.await_args.args[1] == "child"


@pytest.mark.asyncio
async def test_stat_rejects_a_missing_child_beneath_a_valid_row(monkeypatch):
    row = {
        "id": "row",
        "parent": {"data_source_id": "ds"},
        "properties": {
            "Name": {"type": "title", "title": [{"plain_text": "Row"}]}
        },
    }
    monkeypatch.setattr(
        notion_resolve, "get_page", AsyncMock(return_value=row)
    )
    listing = AsyncMock(return_value=[])
    monkeypatch.setattr(
        "mirage.core.notion.readdir.list_block_children", listing
    )
    accessor = NotionAccessor(NotionConfig(api_key="test"))
    path = PathSpec.from_str_path(
        "/databases/DB__db/DS__ds/Row__row/Fabricated__missing"
    )
    with pytest.raises(FileNotFoundError):
        await stat(accessor, path)
    listing.assert_awaited_once()
    assert listing.await_args.args[1] == "row"
