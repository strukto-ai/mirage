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
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from mirage.core.gsheets.api import SheetsApi, SheetsClient
from tests.e2e.gdrive_mock import FakeRenderApi
from tests.fixtures.google_api import parameter_drift

MANAGER = SimpleNamespace(config=SimpleNamespace(api_base=""))


@pytest.mark.parametrize("fake", [SheetsClient, FakeRenderApi])
def test_each_implementation_takes_the_protocols_parameters(fake):
    assert parameter_drift(SheetsApi, fake) == {}


@pytest.mark.asyncio
async def test_a_spreadsheet_is_read_with_its_values_and_no_formats():
    # spreadsheets.get returns no cell values unless asked, so the
    # rendered .gsheet.json would be tab metadata without this; the mask
    # keeps every cell's formats out of it.
    with patch(
        "mirage.core.gsheets.api.google_get",
        new_callable=AsyncMock,
        return_value={"spreadsheetId": "s1"},
    ) as get:
        result = await SheetsClient(MANAGER).read_spreadsheet("s1")
    assert json.loads(result) == {"spreadsheetId": "s1"}
    get.assert_awaited_once_with(
        MANAGER,
        "https://sheets.googleapis.com/v4/spreadsheets/s1",
        {
            "includeGridData": "true",
            "fields": "spreadsheetId,spreadsheetUrl,properties,namedRanges,"
            "sheets(properties,data(startRow,startColumn,"
            "rowData(values(formattedValue,userEnteredValue,effectiveValue))))",
        },
    )


@pytest.mark.asyncio
async def test_a_range_is_read_through_the_values_api():
    with patch(
        "mirage.core.gsheets.api.google_get",
        new_callable=AsyncMock,
        return_value={"values": [["a"]]},
    ) as get:
        result = await SheetsClient(MANAGER).read_values("s1", "A1:B2")
    assert json.loads(result) == {"values": [["a"]]}
    get.assert_awaited_once_with(
        MANAGER,
        "https://sheets.googleapis.com/v4/spreadsheets/s1/values/A1:B2",
    )
