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

from mirage.accessor.slack import SlackAccessor
from mirage.core.slack.client import slack_get


async def cursor_pages(
    accessor: SlackAccessor,
    endpoint: str,
    base_params: dict[str, Any],
    items_key: str,
) -> AsyncIterator[list[dict[str, Any]]]:
    """Walk a cursor-paginated Slack endpoint, one page per round-trip.

    Args:
        accessor (SlackAccessor): Slack accessor.
        endpoint (str): Slack API method, e.g. "conversations.list".
        base_params (dict): per-request params; "cursor" is set here.
        items_key (str): top-level response key holding the page list
            (e.g. "channels", "members", "messages").
    Yields:
        list[dict]: items in each page. Generator returns when Slack
        signals last page (empty next_cursor).
    """
    cursor: str | None = None
    while True:
        params = dict(base_params)
        if cursor:
            params["cursor"] = cursor
        data = await slack_get(accessor, endpoint, params=params)
        yield data.get(items_key, []) or []
        cursor = data.get("response_metadata", {}).get("next_cursor") or None
        if cursor is None:
            return
