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
from typing import Any

import aiohttp

from mirage.core.gsheets._client import (TokenManager, google_headers,
                                         sheets_base)


async def append_values(
    token_manager: TokenManager,
    spreadsheet_id: str,
    range_: str,
    values_json: str,
) -> dict[str, Any]:
    """Append cell values via Values API (POST :append).

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.
        spreadsheet_id (str): Google Sheets spreadsheet ID.
        range_ (str): A1 notation range.
        values_json (str): JSON string of 2D values array.

    Returns:
        dict: API response.
    """
    try:
        values = json.loads(values_json)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON: {exc}") from exc
    base = f"{sheets_base(token_manager)}/spreadsheets/{spreadsheet_id}"
    url = f"{base}/values/{range_}:append?valueInputOption=USER_ENTERED"
    headers = await google_headers(token_manager)
    body = {"values": values}
    async with aiohttp.ClientSession() as session:
        async with session.post(url, headers=headers, json=body) as resp:
            resp.raise_for_status()
            return await resp.json()


async def update_values(
    token_manager: TokenManager,
    spreadsheet_id: str,
    range_: str,
    values_json: str,
) -> dict[str, Any]:
    """Overwrite cell values via Values API (PUT).

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.
        spreadsheet_id (str): Google Sheets spreadsheet ID.
        range_ (str): A1 notation range.
        values_json (str): JSON string of 2D values array.

    Returns:
        dict: API response.
    """
    try:
        values = json.loads(values_json)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON: {exc}") from exc
    base = f"{sheets_base(token_manager)}/spreadsheets/{spreadsheet_id}"
    url = f"{base}/values/{range_}?valueInputOption=USER_ENTERED"
    headers = await google_headers(token_manager)
    body = {"values": values}
    async with aiohttp.ClientSession() as session:
        async with session.put(url, headers=headers, json=body) as resp:
            resp.raise_for_status()
            return await resp.json()
