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

from mirage.accessor.gsheets import GSheetsAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.google.client import TokenManager, google_get, sheets_base
from mirage.core.google.entry import resolve_app_entry
from mirage.core.gsheets.constants import MIME
from mirage.core.gsheets.scope import detect_scope
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.render.json import compact_json_bytes
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.vfs.gsheets.sheet_entry import make_filename

GRID_DATA_PARAM = "true"
# The fields vfs/gsheets/prompt.py documents. Without a mask every cell
# also carries userEnteredFormat and effectiveFormat and every grid its
# row and column metadata, which outweigh the values many times over.
SPREADSHEET_FIELDS = (
    "spreadsheetId,spreadsheetUrl,properties,namedRanges,"
    "sheets(properties,data(startRow,startColumn,"
    "rowData(values(formattedValue,userEnteredValue,effectiveValue))))"
)


async def read_spreadsheet(
    token_manager: TokenManager, spreadsheet_id: str
) -> bytes:
    """Fetch spreadsheet JSON, cell values included and formats left out.

    `spreadsheets.get` returns no grid data unless asked, so without
    `includeGridData` the rendered `.gsheet.json` is tab metadata and
    nothing an agent can read a cell from. The `fields` mask then keeps
    the structure the VFS prompt documents; formatting stays reachable
    through `gws sheets spreadsheets get`.

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.
        spreadsheet_id (str): Google Sheets spreadsheet ID.

    Returns:
        bytes: JSON response as bytes.
    """
    url = f"{sheets_base(token_manager)}/spreadsheets/{spreadsheet_id}"
    data = await google_get(
        token_manager,
        url,
        {"includeGridData": GRID_DATA_PARAM, "fields": SPREADSHEET_FIELDS},
    )
    return compact_json_bytes(data)


async def read_values(
    token_manager: TokenManager, spreadsheet_id: str, range_: str
) -> bytes:
    """Read cell values via Values API. Returns JSON array.

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.
        spreadsheet_id (str): Google Sheets spreadsheet ID.
        range_ (str): A1 notation range.

    Returns:
        bytes: JSON response as bytes.
    """
    base = sheets_base(token_manager)
    url = f"{base}/spreadsheets/{spreadsheet_id}/values/{range_}"
    data = await google_get(token_manager, url)
    return compact_json_bytes(data)


async def _read_file(
    accessor: GSheetsAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
) -> bytes:
    entry = await resolve_app_entry(
        accessor.token_manager,
        match,
        path,
        index,
        MIME,
        "gsheets/file",
        make_filename,
    )
    timer = start_op()
    data = await read_spreadsheet(accessor.token_manager, entry.id)
    record(
        "read",
        path.virtual,
        "gsheets",
        len(data),
        timer,
        fingerprint=entry.remote_time or None,
    )
    return data


read = make_read(detect_scope, readers={"file": _read_file})
