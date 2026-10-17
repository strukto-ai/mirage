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
from mirage.core.slack.paginate import cursor_pages


def _channel_base_params(types: str, limit: int) -> dict[str, Any]:
    return {"types": types, "limit": limit, "exclude_archived": "true"}


def list_channels_stream(
    accessor: SlackAccessor,
    types: str = "public_channel,private_channel",
    limit: int = 200,
) -> AsyncIterator[list[dict[str, Any]]]:
    """Page-streaming variant: yields one Slack page per HTTP round-trip.

    Args:
        accessor (SlackAccessor): Slack accessor.
        types (str): channel types to list.
        limit (int): max per page.

    Yields:
        list[dict]: channels in one Slack page.
    """
    return cursor_pages(
        accessor,
        "conversations.list",
        base_params=_channel_base_params(types, limit),
        items_key="channels",
    )


async def list_channels(
    accessor: SlackAccessor,
    types: str = "public_channel,private_channel",
    limit: int = 200,
) -> list[dict[str, Any]]:
    """List channels via conversations.list (eager; collects all pages).

    Args:
        accessor (SlackAccessor): Slack accessor.
        types (str): channel types to list.
        limit (int): max per page.

    Returns:
        list[dict]: channel metadata dicts.
    """
    out: list[dict[str, Any]] = []
    async for page in list_channels_stream(accessor, types=types, limit=limit):
        out.extend(page)
    return out


async def list_dms(
    accessor: SlackAccessor, limit: int = 200
) -> list[dict[str, Any]]:
    """List direct messages via conversations.list (eager).

    Args:
        accessor (SlackAccessor): Slack accessor.
        limit (int): max per page.

    Returns:
        list[dict]: DM channel dicts.
    """
    return await list_channels(accessor, types="im,mpim", limit=limit)
