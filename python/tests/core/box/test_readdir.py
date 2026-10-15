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

from mirage.core.box.client import BoxApiError
from mirage.core.box.readdir import readdir
from mirage.types import FileStat, FileType, PathSpec

ROOT = PathSpec(vfs_path="", virtual="/", directory="/")
DOCS = PathSpec(vfs_path="docs", virtual="/docs", directory="/docs")
DOCS_ROW = FileStat(
    name="docs", type=FileType.DIRECTORY, extra={"box_id": "100"}
)


def _listing(items):
    return patch(
        "mirage.core.box.readdir.list_folder_items",
        new_callable=AsyncMock,
        return_value=items,
    )


@pytest.mark.asyncio
async def test_readdir_root_lists_folder_zero(accessor):
    items = [
        {
            "id": "100",
            "name": "docs",
            "type": "folder",
            "modified_at": "2026-04-01T00:00:00+00:00",
        },
        {
            "id": "200",
            "name": "a.txt",
            "type": "file",
            "size": 5,
            "modified_at": "2026-04-01T00:00:00+00:00",
        },
    ]
    with _listing(items) as mock_list:
        rows = await readdir(accessor, ROOT)
    assert [row.name for row in rows] == ["a.txt", "docs"]
    mock_list.assert_awaited_once_with(accessor.token_manager, "0")
    file, folder = rows
    assert file.extra["box_id"] == "200"
    assert file.size == 5
    assert folder.type is FileType.DIRECTORY
    assert folder.size is None


@pytest.mark.asyncio
async def test_readdir_box_native_files_surface_raw(accessor):
    items = [
        {
            "id": "300",
            "name": "meeting.boxnote",
            "type": "file",
            "size": 42,
            "modified_at": "2026-04-01T00:00:00+00:00",
        }
    ]
    with _listing(items):
        rows = await readdir(accessor, ROOT)
    assert [row.name for row in rows] == ["meeting.boxnote"]
    assert rows[0].extra["resource_type"] == "box/file"


@pytest.mark.asyncio
async def test_readdir_hides_web_links(accessor):
    items = [
        {"id": "1", "name": "link", "type": "web_link"},
        {"id": "2", "name": "a.txt", "type": "file", "size": 1},
    ]
    with _listing(items):
        rows = await readdir(accessor, ROOT)
    assert [row.name for row in rows] == ["a.txt"]


@pytest.mark.asyncio
async def test_readdir_lists_a_subfolder_by_its_row(accessor):
    items = [
        {
            "id": "400",
            "name": "notes.txt",
            "type": "file",
            "size": 3,
            "modified_at": "2026-04-01T00:00:00+00:00",
        }
    ]
    with _listing(items) as mock_list:
        rows = await readdir(accessor, DOCS, DOCS_ROW)
    assert [row.name for row in rows] == ["notes.txt"]
    mock_list.assert_awaited_once_with(accessor.token_manager, "100")


@pytest.mark.asyncio
async def test_readdir_missing_folder_raises(accessor):
    with _listing([]) as mock_list:
        with pytest.raises(FileNotFoundError):
            await readdir(
                accessor,
                PathSpec(
                    vfs_path="ghost", virtual="/ghost", directory="/ghost"
                ),
            )
    mock_list.assert_not_awaited()


@pytest.mark.asyncio
async def test_readdir_of_a_file_is_enotdir(accessor):
    row = FileStat(name="a.txt", type=FileType.FILE, extra={"box_id": "200"})
    with _listing([]) as mock_list:
        with pytest.raises(NotADirectoryError):
            await readdir(
                accessor,
                PathSpec(vfs_path="a.txt", virtual="/a.txt", directory="/"),
                row,
            )
    mock_list.assert_not_awaited()


@pytest.mark.asyncio
async def test_readdir_reads_a_404_listing_as_absence(accessor):
    with patch(
        "mirage.core.box.readdir.list_folder_items",
        new_callable=AsyncMock,
        side_effect=BoxApiError(
            "Box GET /folders/0/items -> 404 not_found", 404
        ),
    ):
        with pytest.raises(FileNotFoundError):
            await readdir(accessor, ROOT)


@pytest.mark.asyncio
async def test_readdir_keeps_a_throttled_listing_a_failure(accessor):
    with patch(
        "mirage.core.box.readdir.list_folder_items",
        new_callable=AsyncMock,
        side_effect=BoxApiError(
            "Box GET /folders/0/items -> 429 rate_limit", 429
        ),
    ):
        with pytest.raises(BoxApiError) as caught:
            await readdir(accessor, ROOT)
    assert caught.value.status == 429


@pytest.mark.asyncio
@pytest.mark.parametrize("sha1, kept", [(5, None), ("", None), ("abc", "abc")])
async def test_readdir_keeps_only_a_string_sha1(accessor, sha1, kept):
    items = [
        {"id": "200", "name": "a.txt", "type": "file", "size": 1, "sha1": sha1}
    ]
    with _listing(items):
        rows = await readdir(accessor, ROOT)
    assert rows[0].extra.get("sha1") == kept
    assert rows[0].fingerprint == kept


@pytest.mark.asyncio
async def test_readdir_rows_carry_the_etag_a_write_sends(accessor):
    items = [
        {"id": "200", "name": "a.txt", "type": "file", "size": 1, "etag": "3"}
    ]
    with _listing(items):
        rows = await readdir(accessor, ROOT)
    assert rows[0].extra["etag"] == "3"
