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

from mirage.core.gsheets._client import (SHEETS_API_BASE, TokenManager,
                                         google_post)


async def batch_update(
    token_manager: TokenManager,
    spreadsheet_id: str,
    requests_json: str,
) -> dict[str, Any]:
    """Send batchUpdate to Google Sheets API.

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.
        spreadsheet_id (str): Google Sheets spreadsheet ID.
        requests_json (str): JSON string with "requests" key.

    Returns:
        dict: API response.
    """
    try:
        payload = json.loads(requests_json)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"Invalid JSON: {exc}. Payload must contain 'requests' key."
        ) from exc
    if "requests" not in payload:
        raise ValueError("Payload must contain 'requests' key.")
    url = f"{SHEETS_API_BASE}/spreadsheets/{spreadsheet_id}:batchUpdate"
    return await google_post(token_manager, url, payload)
