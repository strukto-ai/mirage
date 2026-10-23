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

from dataclasses import dataclass
from typing import Protocol

from mirage.core.google.client import TokenManager, google_get, sheets_base
from mirage.core.render.json import compact_json_bytes

GRID_DATA_PARAM = "true"
# The fields vfs/gsheets/prompt.py documents. Without a mask every cell
# also carries userEnteredFormat and effectiveFormat and every grid its
# row and column metadata, which outweigh the values many times over.
SPREADSHEET_FIELDS = (
    "spreadsheetId,spreadsheetUrl,properties,namedRanges,"
    "sheets(properties,data(startRow,startColumn,"
    "rowData(values(formattedValue,userEnteredValue,effectiveValue))))"
)


class SheetsApi(Protocol):
    """Every Sheets read a Google backend makes, as one object.

    A core op reaches Sheets only through its accessor's ``sheets``, so
    the backend runs against an in-memory Sheets wherever another
    implementation is served there.
    """

    async def read_spreadsheet(self, spreadsheet_id: str) -> bytes: ...

    async def read_values(self, spreadsheet_id: str, range_: str) -> bytes: ...


@dataclass(frozen=True, slots=True)
class SheetsClient:
    """The live ``SheetsApi``: one token manager, one wire call per
    method."""

    token_manager: TokenManager

    async def read_spreadsheet(self, spreadsheet_id: str) -> bytes:
        """Fetch spreadsheet JSON, cell values included and formats left out.

        `spreadsheets.get` returns no grid data unless asked, so without
        `includeGridData` the rendered `.gsheet.json` is tab metadata and
        nothing an agent can read a cell from. The `fields` mask then keeps
        the structure the VFS prompt documents; formatting stays reachable
        through `gws sheets spreadsheets get`.

        Args:
            spreadsheet_id (str): Google Sheets spreadsheet ID.

        Returns:
            bytes: JSON response as bytes.
        """
        base = sheets_base(self.token_manager)
        data = await google_get(
            self.token_manager,
            f"{base}/spreadsheets/{spreadsheet_id}",
            {"includeGridData": GRID_DATA_PARAM, "fields": SPREADSHEET_FIELDS},
        )
        return compact_json_bytes(data)

    async def read_values(self, spreadsheet_id: str, range_: str) -> bytes:
        """Read cell values via Values API. Returns JSON array.

        Args:
            spreadsheet_id (str): Google Sheets spreadsheet ID.
            range_ (str): A1 notation range.

        Returns:
            bytes: JSON response as bytes.
        """
        base = sheets_base(self.token_manager)
        url = f"{base}/spreadsheets/{spreadsheet_id}/values/{range_}"
        data = await google_get(self.token_manager, url)
        return compact_json_bytes(data)
