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
from collections.abc import AsyncIterator
from datetime import datetime, timezone

from mirage.core.slack.paginate import cursor_pages
from mirage.resource.slack.config import SlackConfig


def _day_bounds_ts(date_str: str) -> tuple[str, str]:
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    oldest = str(dt.timestamp())
    latest = str(dt.replace(hour=23, minute=59, second=59).timestamp())
    return oldest, latest


def stream_messages_for_day(
    config: SlackConfig,
    channel_id: str,
    date_str: str,
    limit: int = 200,
) -> AsyncIterator[list[dict]]:
    """Page-streaming history for a channel-day.

    Args:
        config (SlackConfig): Slack credentials.
        channel_id (str): channel ID.
        date_str (str): date in YYYY-MM-DD format.
        limit (int): max per page.

    Yields:
        list[dict]: messages in one Slack page (unsorted; the eager
        wrapper sorts at the end).
    """
    oldest, latest = _day_bounds_ts(date_str)
    return cursor_pages(
        config,
        "conversations.history",
        base_params={
            "channel": channel_id,
            "oldest": oldest,
            "latest": latest,
            "limit": limit,
            "inclusive": "true",
        },
        items_key="messages",
    )


async def fetch_messages_for_day(
    config: SlackConfig,
    channel_id: str,
    date_str: str,
) -> list[dict]:
    """Fetch all messages for a date as parsed dicts (eager).

    Args:
        config (SlackConfig): Slack credentials.
        channel_id (str): channel ID.
        date_str (str): date in YYYY-MM-DD format.

    Returns:
        list[dict]: messages sorted by ts ascending.
    """
    messages: list[dict] = []
    async for page in stream_messages_for_day(config, channel_id, date_str):
        messages.extend(page)
    messages.sort(key=lambda m: float(m.get("ts", "0")))
    return messages


async def get_history_jsonl(
    config: SlackConfig,
    channel_id: str,
    date_str: str,
) -> bytes:
    """Fetch channel messages for a specific date as JSONL.

    Args:
        config (SlackConfig): Slack credentials.
        channel_id (str): channel ID.
        date_str (str): date in YYYY-MM-DD format.

    Returns:
        bytes: JSONL-encoded messages.
    """
    messages = await fetch_messages_for_day(config, channel_id, date_str)
    lines = [json.dumps(m, ensure_ascii=False) for m in messages]
    return ("\n".join(lines) + "\n").encode() if lines else b""


def stream_thread_replies(
    config: SlackConfig,
    channel_id: str,
    thread_ts: str,
    limit: int = 200,
) -> AsyncIterator[list[dict]]:
    """Page-streaming thread replies.

    Args:
        config (SlackConfig): Slack credentials.
        channel_id (str): channel ID.
        thread_ts (str): parent message ts.
        limit (int): max per page.

    Yields:
        list[dict]: reply messages in one Slack page.
    """
    return cursor_pages(
        config,
        "conversations.replies",
        base_params={
            "channel": channel_id,
            "ts": thread_ts,
            "limit": limit,
        },
        items_key="messages",
    )


async def get_thread_jsonl(
    config: SlackConfig,
    channel_id: str,
    thread_ts: str,
) -> list[dict]:
    """Fetch thread replies (eager).

    Args:
        config (SlackConfig): Slack credentials.
        channel_id (str): channel ID.
        thread_ts (str): parent message ts.

    Returns:
        list[dict]: reply messages.
    """
    replies: list[dict] = []
    async for page in stream_thread_replies(config, channel_id, thread_ts):
        replies.extend(page)
    return replies
