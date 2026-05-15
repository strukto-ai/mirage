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

from collections.abc import AsyncIterator
from typing import Any

from mirage.core.slack._client import slack_get
from mirage.resource.slack.config import SlackConfig


async def cursor_pages(
    config: SlackConfig,
    endpoint: str,
    base_params: dict,
    items_key: str,
    token: str | None = None,
) -> AsyncIterator[list[dict]]:
    """Walk a cursor-paginated Slack endpoint, one page per round-trip.

    Args:
        config (SlackConfig): Slack credentials.
        endpoint (str): Slack API method, e.g. "conversations.list".
        base_params (dict): per-request params; "cursor" is set here.
        items_key (str): top-level response key holding the page list
            (e.g. "channels", "members", "messages").
        token (str | None): override token; falls back to config.token.

    Yields:
        list[dict]: items in each page. Generator returns when Slack
        signals last page (empty next_cursor).
    """
    cursor: str | None = None
    while True:
        params = dict(base_params)
        if cursor:
            params["cursor"] = cursor
        data = await slack_get(config, endpoint, params=params, token=token)
        yield data.get(items_key, []) or []
        cursor = data.get("response_metadata", {}).get("next_cursor") or None
        if cursor is None:
            return


def _get_nested(d: dict, path: tuple[str, ...]) -> Any:
    cur: Any = d
    for k in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


async def offset_pages(
    config: SlackConfig,
    endpoint: str,
    base_params: dict,
    pages_path: tuple[str, ...],
    items_path: tuple[str, ...],
    start_page: int = 1,
    max_pages: int | None = None,
    token: str | None = None,
) -> AsyncIterator[list[dict]]:
    """Walk a page-paginated Slack endpoint (search, files.list, ...).

    Args:
        config (SlackConfig): Slack credentials.
        endpoint (str): Slack API method, e.g. "search.messages".
        base_params (dict): per-request params; "page" is set here.
        pages_path (tuple[str, ...]): nested path to total page count
            in the response, e.g. ("messages", "pagination",
            "page_count").
        items_path (tuple[str, ...]): nested path to items list, e.g.
            ("messages", "matches").
        start_page (int): page number to start from (1-based).
        max_pages (int | None): cap on pages fetched; None = unbounded.
        token (str | None): override token.

    Yields:
        list[dict]: items from each page.
    """
    page = start_page
    total_pages: int | None = None
    fetched = 0
    while True:
        params = dict(base_params)
        params["page"] = str(page)
        data = await slack_get(config, endpoint, params=params, token=token)
        items = _get_nested(data, items_path) or []
        yield items
        fetched += 1
        if total_pages is None:
            total_pages = _get_nested(
                data, pages_path
            ) or 1  # stop after one page if pagination metadata is missing
        if page >= total_pages:
            return
        if max_pages is not None and fetched >= max_pages:
            return
        page += 1
