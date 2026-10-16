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

from typing import Any

from mirage.core.google.client import TokenManager, gmail_base, google_get

MAX_PAGES = 50


async def current_history_id(token_manager: TokenManager) -> str:
    """The mailbox's history id now, where a delta starts from.

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.
    """
    url = f"{gmail_base(token_manager)}/users/me/profile"
    data = await google_get(token_manager, url)
    return str(data["historyId"])


async def list_history(
    token_manager: TokenManager, start: str
) -> tuple[list[dict[str, Any]], str]:
    """The mailbox's history records after ``start``, and the history id
    they reach.

    Gmail answers 404 for a start older than the history it keeps, which
    raises as any failed call does.

    Args:
        token_manager (TokenManager): manages OAuth2 tokens.
        start (str): the history id the records come after.
    """
    url = f"{gmail_base(token_manager)}/users/me/history"
    records: list[dict[str, Any]] = []
    latest = start
    token: str | None = None
    for _ in range(MAX_PAGES):
        params: dict[str, Any] = {"startHistoryId": start, "maxResults": 500}
        if token:
            params["pageToken"] = token
        data = await google_get(token_manager, url, params=params)
        records.extend(data.get("history", []))
        latest = str(data.get("historyId", latest))
        token = data.get("nextPageToken")
        if not token:
            return records, latest
    raise RuntimeError("gmail: history exceeded 50 pages")
