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

from mirage.accessor.gsheets import GSheetsAccessor
from mirage.core.gsheets.read import read
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gsheets import GSheetsVFS
from tests.fixtures.gdrive_api import StubDrive
from tests.fixtures.google_api import offline_token_manager, serve
from tests.fixtures.gsheets_api import StubSheets
from tests.fixtures.mounted import Mounted


@pytest.fixture
def accessor():
    return GSheetsAccessor(config=None, token_manager=offline_token_manager())


@pytest.mark.asyncio
async def test_a_read_no_listing_named_resolves_by_id(accessor):
    files = [
        {
            "mimeType": "application/vnd.google-apps.spreadsheet",
            "id": "sheet1",
            "name": "Budget",
            "modifiedTime": "2026-04-01T00:00:00.000Z",
            "owners": [{"me": True}],
        }
    ]
    with (
        serve(
            drive=StubDrive(get_file=AsyncMock(return_value=files[0])),
            sheets=StubSheets(
                read_spreadsheet=AsyncMock(
                    return_value=b'{"spreadsheetId":"sheet1"}'
                )
            ),
        ),
    ):
        path = PathSpec(
            vfs_path=mount_key(
                "/gsheets/owned/2026-04-01_Budget__sheet1.gsheet.json",
                "/gsheets",
            ),
            virtual="/gsheets/owned/2026-04-01_Budget__sheet1.gsheet.json",
            directory="/gsheets/owned/2026-04-01_Budget__sheet1.gsheet.json",
        )
        result = await read(accessor, path)
        assert b"sheet1" in result


@pytest.mark.asyncio
async def test_read_missing_file_raises_by_id(accessor):
    with (
        serve(
            drive=StubDrive(
                get_file=AsyncMock(side_effect=FileNotFoundError("missing"))
            ),
            sheets=StubSheets(
                read_spreadsheet=AsyncMock(
                    side_effect=AssertionError(
                        "should not call read_spreadsheet"
                    )
                )
            ),
        ),
    ):
        path = PathSpec(
            vfs_path=mount_key(
                "/gsheets/owned/Missing__xyz.gsheet.json", "/gsheets"
            ),
            virtual="/gsheets/owned/Missing__xyz.gsheet.json",
            directory="/gsheets/owned/Missing__xyz.gsheet.json",
        )
        with pytest.raises(FileNotFoundError):
            await read(accessor, path)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("stamp", "token"),
    [("2026-04-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z"), ("", None)],
)
async def test_read_records_the_token_stat_reports(accessor, stamp, token):
    # read: fresh compares this record with stat's fingerprint, so both take
    # the file's modified stamp, and a file without one stamps nothing.
    item = {
        "mimeType": "application/vnd.google-apps.spreadsheet",
        "id": "s1",
        "name": "My Sheet",
        "modifiedTime": stamp,
        "owners": [{"me": True}],
    }
    mounted = Mounted(GSheetsVFS, accessor, "/gsheets")
    scope = RecordingScope()
    try:
        with (
            serve(
                drive=StubDrive(
                    list_all_files=AsyncMock(return_value=([item], True)),
                    get_file=AsyncMock(return_value=item),
                ),
                sheets=StubSheets(
                    read_spreadsheet=AsyncMock(
                        return_value=b'{"spreadsheetId":"s1"}'
                    )
                ),
            ),
        ):
            (target,) = await mounted.readdir("/owned")
            path = PathSpec(
                vfs_path=mount_key(target, "/gsheets"),
                virtual=target,
                directory=target,
            )
            data = await read(accessor, path)
            info = await mounted.stat(path)
    finally:
        scope.close()

    assert [
        (r.op, r.path, r.source, r.bytes, r.fingerprint) for r in scope.records
    ] == [("read", target, "gsheets", len(data), token)]
    assert info.fingerprint == token
