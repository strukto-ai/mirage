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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gdrive import GoogleDriveVFS
from tests.fixtures.google_api import offline_token_manager, serve
from tests.fixtures.gsheets_api import StubSheets
from tests.fixtures.vfs_io import call_over


def _op(name: str):
    return call_over(GoogleDriveVFS, name)


read = _op("read")


def _scope(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(path, prefix),
        virtual=path,
        directory=path.rsplit("/", 1)[0] or "/",
    )


@pytest.fixture
def accessor():
    return GDriveAccessor(config=None, token_manager=offline_token_manager())


@pytest.mark.asyncio
async def test_read_gsheet_renders_spreadsheet_json(accessor):
    row = FileStat(
        name="budget.gsheet.json",
        type=FileType.FILE,
        modified="2026-04-01T00:00:00Z",
        extra={"file_id": "sheet123", "resource_type": "gdrive/gsheet"},
    )
    sheet_json = json.dumps({"spreadsheetId": "sheet123"}).encode()
    mock = AsyncMock(return_value=sheet_json)
    with serve(sheets=StubSheets(read_spreadsheet=mock)):
        result = await read(
            accessor, _scope("/sheets/budget.gsheet.json"), entry=row
        )
        mock.assert_called_once_with("sheet123")
        assert json.loads(result)["spreadsheetId"] == "sheet123"


@pytest.mark.asyncio
async def test_read_gsheet_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await read(accessor, _scope("/nonexistent.gsheet.json"))
