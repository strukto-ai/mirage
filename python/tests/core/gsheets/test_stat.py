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

from mirage.accessor.gsheets import GSheetsAccessor
from mirage.core.gsheets.stat import stat
from mirage.types import ContentType, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gsheets import GSheetsVFS
from tests.fixtures.mounted import Mounted


@pytest.fixture
def accessor():
    return GSheetsAccessor(config=None, token_manager=None)


@pytest.mark.asyncio
async def test_stat_root(accessor):
    result = await stat(
        accessor,
        PathSpec(
            vfs_path=mount_key("/gsheets", "/gsheets"),
            virtual="/gsheets",
            directory="/gsheets",
        ),
    )
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_owned_dir(accessor):
    result = await stat(
        accessor,
        PathSpec(
            vfs_path=mount_key("/gsheets/owned", "/gsheets"),
            virtual="/gsheets/owned",
            directory="/gsheets/owned",
        ),
    )
    assert result.type == FileType.DIRECTORY
    assert result.name == "owned"


@pytest.mark.asyncio
async def test_stat_sheet_from_the_listing(accessor):
    stamp = "2026-04-01T00:00:00.000Z"
    item = {
        "mimeType": "application/vnd.google-apps.spreadsheet",
        "id": "s1",
        "name": "My Sheet",
        "modifiedTime": stamp,
        "owners": [{"me": True}],
    }
    mounted = Mounted(GSheetsVFS, accessor, "/gsheets")
    with patch(
        "mirage.core.google.readdir.list_all_files",
        new_callable=AsyncMock,
        return_value=([item], True),
    ):
        (target,) = await mounted.readdir("/owned")
        result = await mounted.stat(target.removeprefix("/gsheets"))
    assert target == "/gsheets/owned/2026-04-01_My_Sheet__s1.gsheet.json"
    assert result.content == ContentType.JSON
    assert result.extra["doc_id"] == "s1"
    assert result.fingerprint == stamp


@pytest.mark.asyncio
async def test_stat_cache_miss_fetches_metadata_by_id(accessor):
    files = [
        {
            "mimeType": "application/vnd.google-apps.spreadsheet",
            "id": "s1",
            "name": "My Sheet",
            "modifiedTime": "2026-04-01T00:00:00.000Z",
            "size": "512",
            "owners": [{"me": True}],
        }
    ]
    target = "/gsheets/owned/2026-04-01_My_Sheet__s1.gsheet.json"
    with patch(
        "mirage.core.google.entry.get_file",
        new_callable=AsyncMock,
        return_value=files[0],
    ) as mock_list:
        result = await stat(
            accessor,
            PathSpec(
                vfs_path=mount_key(target, "/gsheets"),
                virtual=target,
                directory=target,
            ),
        )
    assert result.content == ContentType.JSON
    assert result.extra["doc_id"] == "s1"
    assert mock_list.call_count == 1


@pytest.mark.asyncio
async def test_stat_not_found_after_fallback(accessor):
    files = [
        {
            "mimeType": "application/vnd.google-apps.spreadsheet",
            "id": "s1",
            "name": "Other",
            "modifiedTime": "2026-04-01T00:00:00.000Z",
            "owners": [{"me": True}],
        }
    ]
    with patch(
        "mirage.core.google.entry.get_file",
        new_callable=AsyncMock,
        return_value=files[0],
    ):
        with pytest.raises(FileNotFoundError):
            await stat(
                accessor,
                PathSpec(
                    vfs_path=mount_key(
                        "/gsheets/owned/nope.gsheet.json", "/gsheets"
                    ),
                    virtual="/gsheets/owned/nope.gsheet.json",
                    directory="/gsheets/owned/nope.gsheet.json",
                ),
            )
