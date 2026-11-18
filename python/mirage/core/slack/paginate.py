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

from collections.abc import AsyncIterator, Mapping
from contextlib import aclosing
from typing import TYPE_CHECKING, Any, Literal, overload

from mirage.accessor.slack import SlackAccessor
from mirage.core.api.paginate import PageShape
from mirage.core.api.paginate import cursor_pages as api_pages
from mirage.core.slack.client import slack_get

if TYPE_CHECKING:
    from mirage.core.slack.channels import SlackChannel
    from mirage.core.slack.history import SlackMessage
    from mirage.core.slack.users import SlackUser


@overload
def cursor_pages(
    accessor: SlackAccessor,
    endpoint: str,
    base_params: dict[str, Any],
    items_key: Literal["channels"],
) -> AsyncIterator[list["SlackChannel"]]: ...


@overload
def cursor_pages(
    accessor: SlackAccessor,
    endpoint: str,
    base_params: dict[str, Any],
    items_key: Literal["messages"],
) -> AsyncIterator[list["SlackMessage"]]: ...


@overload
def cursor_pages(
    accessor: SlackAccessor,
    endpoint: str,
    base_params: dict[str, Any],
    items_key: Literal["members"],
) -> AsyncIterator[list["SlackUser"]]: ...


async def cursor_pages(
    accessor: SlackAccessor,
    endpoint: str,
    base_params: dict[str, Any],
    items_key: str,
) -> AsyncIterator[list[Any]]:
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

    async def fetch_page(cursor: str | None) -> dict[str, Any]:
        params = {**base_params, "cursor": cursor} if cursor else base_params
        return await slack_get(accessor, endpoint, params=params)

    async with aclosing(
        api_pages(fetch_page, shape=PageShape(items_key, _next_cursor))
    ) as pages:
        async for page in pages:
            yield page


def _next_cursor(data: Mapping[str, Any]) -> str | None:
    metadata = data.get("response_metadata")
    cursor = (
        metadata.get("next_cursor") if isinstance(metadata, dict) else None
    )
    return cursor if isinstance(cursor, str) and cursor else None
