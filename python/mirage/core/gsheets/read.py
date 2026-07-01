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
import posixpath

from mirage.accessor.gsheets import GSheetsAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.gsheets._client import (SHEETS_API_BASE, TokenManager,
                                         google_get)
from mirage.core.gsheets.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def read_spreadsheet(token_manager: TokenManager,
                           spreadsheet_id: str) -> bytes:
    """Fetch full spreadsheet JSON.

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.
        spreadsheet_id (str): Google Sheets spreadsheet ID.

    Returns:
        bytes: JSON response as bytes.
    """
    url = f"{SHEETS_API_BASE}/spreadsheets/{spreadsheet_id}"
    data = await google_get(token_manager, url)
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()


async def read_values(token_manager: TokenManager, spreadsheet_id: str,
                      range_: str) -> bytes:
    """Read cell values via Values API. Returns JSON array.

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.
        spreadsheet_id (str): Google Sheets spreadsheet ID.
        range_ (str): A1 notation range.

    Returns:
        bytes: JSON response as bytes.
    """
    url = f"{SHEETS_API_BASE}/spreadsheets/{spreadsheet_id}/values/{range_}"
    data = await google_get(token_manager, url)
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()


async def fetch_sheet_names(
    token_manager: TokenManager,
    spreadsheet_id: str,
) -> list[str]:
    """Fetch sheet tab names for a spreadsheet.

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.
        spreadsheet_id (str): Google Sheets spreadsheet ID.

    Returns:
        list[str]: list of sheet tab names.
    """
    fields = "sheets.properties.title"
    url = f"{SHEETS_API_BASE}/spreadsheets/{spreadsheet_id}?fields={fields}"
    data = await google_get(token_manager, url)
    return [s["properties"]["title"] for s in data.get("sheets", [])]


async def read(
    accessor: GSheetsAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> bytes:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    virtual = path.original
    prefix = path.prefix
    key = path.key
    if index is None:
        raise enoent(virtual)
    virtual_key = prefix + "/" + key if prefix else "/" + key
    result = await index.get(virtual_key)
    if result.entry is None:
        parent_key = posixpath.dirname(virtual_key) or "/"
        if parent_key != virtual_key:
            parent_path = PathSpec.from_str_path(parent_key, prefix=prefix)
            try:
                await readdir(accessor, parent_path, index)
                result = await index.get(virtual_key)
            except Exception:
                pass
        if result.entry is None:
            raise enoent(virtual)
    return await read_spreadsheet(accessor.token_manager, result.entry.id)
