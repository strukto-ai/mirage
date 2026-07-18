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
from typing import Any

from mirage.core.discord.paginate import after_id_pages
from mirage.resource.discord.config import DiscordConfig

DISCORD_EPOCH = 1420070400000


def date_to_snowflake(date_str: str, end: bool = False) -> str:
    """Convert a YYYY-MM-DD date to a Discord snowflake bound.

    Args:
        date_str (str): YYYY-MM-DD date.
        end (bool): when True, returns the snowflake for 23:59:59 UTC.

    Returns:
        str: snowflake id usable as ``after``/``before`` parameter.
    """
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    if end:
        dt = dt.replace(hour=23, minute=59, second=59)
    ms = int(dt.timestamp() * 1000) - DISCORD_EPOCH
    return str(ms << 22)


async def stream_messages_for_day(
    config: DiscordConfig,
    channel_id: str,
    date_str: str,
    page_size: int = 100,
) -> AsyncIterator[list[dict[str, Any]]]:
    """Stream message pages for a channel-day.

    Walks ``/channels/<id>/messages?after=<snowflake>&limit=N``
    forward through the day, stopping when messages exceed the
    end-of-day snowflake.

    Args:
        config (DiscordConfig): Discord credentials.
        channel_id (str): channel ID.
        date_str (str): YYYY-MM-DD.
        page_size (int): per-page limit (Discord caps at 100).

    Yields:
        list[dict]: message dicts, filtered to within the date.
    """
    after = date_to_snowflake(date_str)
    before_int = int(date_to_snowflake(date_str, end=True))
    async for page in after_id_pages(
            config,
            f"/channels/{channel_id}/messages",
            base_params={},
            last_id_fn=lambda m: m["id"],
            page_size=page_size,
            start_after=after,
    ):
        in_range = [m for m in page if int(m["id"]) <= before_int]
        if in_range:
            yield in_range
        if any(int(m["id"]) > before_int for m in page):
            return


async def list_messages_for_day(
    config: DiscordConfig,
    channel_id: str,
    date_str: str,
    page_size: int = 100,
) -> list[dict[str, Any]]:
    """List all messages for a channel-day (eager).

    Args:
        config (DiscordConfig): Discord credentials.
        channel_id (str): channel ID.
        date_str (str): YYYY-MM-DD.
        page_size (int): per-page limit.

    Returns:
        list[dict]: messages within the date, sorted oldest-first.
    """
    out: list[dict[str, Any]] = []
    async for page in stream_messages_for_day(config, channel_id, date_str,
                                              page_size):
        out.extend(page)
    out.sort(key=lambda m: int(m["id"]))
    return out


async def get_history_jsonl(
    config: DiscordConfig,
    channel_id: str,
    date_str: str,
) -> bytes:
    """Fetch channel messages for a date as JSONL.

    Args:
        config (DiscordConfig): Discord credentials.
        channel_id (str): channel ID.
        date_str (str): date in YYYY-MM-DD format.

    Returns:
        bytes: JSONL-encoded messages.
    """
    messages = await list_messages_for_day(config, channel_id, date_str)
    lines = [
        json.dumps(m, ensure_ascii=False, separators=(",", ":"))
        for m in messages
    ]
    return ("\n".join(lines) + "\n").encode() if lines else b""
