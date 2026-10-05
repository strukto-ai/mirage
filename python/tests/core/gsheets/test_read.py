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

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.gsheets import GSheetsAccessor
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.gsheets.read import read, read_spreadsheet
from mirage.core.gsheets.stat import stat
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def accessor():
    return GSheetsAccessor(config=None, token_manager=None)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_read_auto_bootstraps_from_empty_index(accessor, index):
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
        patch(
            "mirage.core.google.entry.get_file",
            new_callable=AsyncMock,
            return_value=files[0],
        ),
        patch(
            "mirage.core.gsheets.read.read_spreadsheet",
            new_callable=AsyncMock,
            return_value=b'{"spreadsheetId":"sheet1"}',
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
        result = await read(accessor, path, index)
        assert b"sheet1" in result


@pytest.mark.asyncio
async def test_read_missing_file_raises_by_id(accessor, index):
    with (
        patch(
            "mirage.core.google.entry.get_file",
            new_callable=AsyncMock,
            side_effect=FileNotFoundError("missing"),
        ),
        patch(
            "mirage.core.gsheets.read.read_spreadsheet",
            new_callable=AsyncMock,
            side_effect=AssertionError("should not call read_spreadsheet"),
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
            await read(accessor, path, index)


@pytest.mark.asyncio
async def test_read_spreadsheet_asks_for_grid_data_and_values_only():
    # spreadsheets.get returns no cell values unless asked, so the
    # rendered .gsheet.json would be tab metadata without this; the mask
    # keeps every cell's formats out of it.
    token_manager = SimpleNamespace(config=SimpleNamespace(api_base=""))
    with patch(
        "mirage.core.gsheets.read.google_get",
        new_callable=AsyncMock,
        return_value={"spreadsheetId": "s1"},
    ) as get:
        await read_spreadsheet(token_manager, "s1")
    assert get.await_args.args[1].endswith("/spreadsheets/s1")
    assert get.await_args.args[2] == {
        "includeGridData": "true",
        "fields": "spreadsheetId,spreadsheetUrl,properties,namedRanges,"
        "sheets(properties,data(startRow,startColumn,"
        "rowData(values(formattedValue,userEnteredValue,effectiveValue))))",
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("stamp", "token"),
    [("2026-04-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z"), ("", None)],
)
async def test_read_records_the_token_stat_reports(
    accessor, index, stamp, token
):
    # read: fresh compares this record with stat's fingerprint, so both take
    # the entry's modified stamp, and an entry without one stamps nothing.
    name = "2026-04-01_My_Sheet__s1.gsheet.json"
    target = "/gsheets/owned/" + name
    await index.set_dir(
        "/gsheets/owned",
        [
            (
                name,
                IndexEntry(
                    id="s1",
                    name="My Sheet",
                    resource_type="gsheets/file",
                    remote_time=stamp,
                    vfs_name=name,
                ),
            ),
        ],
    )
    path = PathSpec(
        vfs_path=mount_key(target, "/gsheets"),
        virtual=target,
        directory=target,
    )
    scope = RecordingScope()
    try:
        with patch(
            "mirage.core.gsheets.read.read_spreadsheet",
            new_callable=AsyncMock,
            return_value=b'{"spreadsheetId":"s1"}',
        ):
            data = await read(accessor, path, index)
    finally:
        scope.close()
    info = await stat(accessor, path, index)

    assert [
        (r.op, r.path, r.source, r.bytes, r.fingerprint) for r in scope.records
    ] == [("read", target, "gsheets", len(data), token)]
    assert info.fingerprint == token
