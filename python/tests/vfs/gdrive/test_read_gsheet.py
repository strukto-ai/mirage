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

import pytest

from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gdrive import GoogleDriveVFS
from tests.fixtures.vfs_io import call_over

MIME = "application/vnd.google-apps.spreadsheet"


def _op(name: str):
    return call_over(GoogleDriveVFS, name)


read = _op("read")


def _scope(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(path, prefix),
        virtual=path,
        directory=path.rsplit("/", 1)[0] or "/",
    )


@pytest.mark.asyncio
async def test_read_gsheet_renders_spreadsheet_json(google_account):
    made = await google_account.create("budget", MIME)
    row = FileStat(
        name="budget.gsheet.json",
        type=FileType.FILE,
        modified="2026-04-01T00:00:00Z",
        extra={"file_id": made, "resource_type": "gdrive/gsheet"},
    )
    await google_account.run.record_requests()
    result = await read(
        google_account.drive_accessor(),
        _scope("/sheets/budget.gsheet.json"),
        entry=row,
    )
    assert [path for _, path in await google_account.log()] == [
        f"/v4/spreadsheets/{made}"
    ]
    assert json.loads(result)["spreadsheetId"] == made


@pytest.mark.asyncio
async def test_read_gsheet_not_found(google_account):
    with pytest.raises(FileNotFoundError):
        await read(
            google_account.drive_accessor(), _scope("/nonexistent.gsheet.json")
        )
