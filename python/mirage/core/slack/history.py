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

from mirage.core.api.client import SessionArg
from mirage.core.render.json import jsonl_bytes
from mirage.core.slack.client import slack_get
from mirage.core.slack.config import SlackConfig
from mirage.core.slack.paginate import cursor_pages
from mirage.core.time_range import TimeRange


async def stream_messages_for_day(
    config: SlackConfig,
    channel_id: str,
    date_str: str,
    scope: TimeRange,
    limit: int = 200,
    session: SessionArg = None,
) -> AsyncIterator[list[dict[str, Any]]]:
    """Page-streaming history for a channel-day.

    Args:
        config (SlackConfig): Slack credentials.
        channel_id (str): channel ID.
        date_str (str): date in YYYY-MM-DD format.
        scope (TimeRange): the mount's time scope, clipping the day.
        limit (int): max per page.
        session (SessionArg): pool or live session to ride.

    Yields:
        list[dict]: messages in one Slack page (unsorted; the eager
        wrapper sorts at the end).
    """
    oldest, latest = scope.day_bounds(date_str)
    if oldest >= latest:
        return
    async for page in cursor_pages(
        config,
        "conversations.history",
        base_params={
            "channel": channel_id,
            "oldest": f"{oldest:.6f}",
            "latest": f"{latest:.6f}",
            "limit": limit,
            "inclusive": "true",
        },
        items_key="messages",
        session=session,
    ):
        yield [
            message
            for message in page
            if oldest <= float(message["ts"]) < latest
        ]


async def fetch_messages_for_day(
    config: SlackConfig,
    channel_id: str,
    date_str: str,
    scope: TimeRange,
    session: SessionArg = None,
) -> list[dict[str, Any]]:
    """Fetch all messages for a date as parsed dicts (eager).

    Args:
        config (SlackConfig): Slack credentials.
        channel_id (str): channel ID.
        date_str (str): date in YYYY-MM-DD format.
        scope (TimeRange): the mount's time scope, clipping the day.
        session (SessionArg): pool or live session to ride.

    Returns:
        list[dict]: messages sorted by ts ascending.
    """
    messages: list[dict[str, Any]] = []
    async for page in stream_messages_for_day(
        config, channel_id, date_str, scope, session=session
    ):
        messages.extend(page)
    messages.sort(key=lambda m: float(m.get("ts", "0")))
    return messages


async def get_history_jsonl(
    config: SlackConfig,
    channel_id: str,
    date_str: str,
    scope: TimeRange,
    session: SessionArg = None,
) -> bytes:
    """Fetch channel messages for a specific date as JSONL.

    Args:
        config (SlackConfig): Slack credentials.
        channel_id (str): channel ID.
        date_str (str): date in YYYY-MM-DD format.
        scope (TimeRange): the mount's time scope, clipping the day.
        session (SessionArg): pool or live session to ride.

    Returns:
        bytes: JSONL-encoded messages.
    """
    messages = await fetch_messages_for_day(
        config, channel_id, date_str, scope, session=session
    )
    return jsonl_bytes(messages)


async def fetch_recent_messages(
    config: SlackConfig,
    channel_id: str,
    limit: int = 20,
    session: SessionArg = None,
) -> list[dict[str, Any]]:
    """Fetch the most recent messages of a channel (one API page).

    Args:
        config (SlackConfig): Slack credentials.
        channel_id (str): channel ID.
        limit (int): maximum number of messages.
        session (SessionArg): pool or live session to ride.

    Returns:
        list[dict]: messages sorted by ts ascending.
    """
    data = await slack_get(
        config,
        "conversations.history",
        {
            "channel": channel_id,
            "limit": limit,
        },
        session=session,
    )
    messages = data.get("messages")
    items = (
        [m for m in messages if isinstance(m, dict)]
        if isinstance(messages, list)
        else []
    )
    items.sort(key=lambda m: float(m.get("ts", "0")))
    return items
