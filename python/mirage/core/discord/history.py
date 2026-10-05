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
from mirage.core.discord.client import discord_get
from mirage.core.discord.config import DiscordConfig
from mirage.core.discord.paginate import after_id_pages
from mirage.core.discord.render import history_jsonl_bytes
from mirage.core.time_range import TimeRange

DISCORD_EPOCH = 1420070400000


def snowflake_at(seconds: float) -> int:
    """The lowest snowflake Discord mints at ``seconds`` of Unix time.

    Args:
        seconds (float): Unix time.
    """
    return (round(seconds * 1000) - DISCORD_EPOCH) << 22


async def stream_messages_for_day(
    config: DiscordConfig,
    channel_id: str,
    date_str: str,
    scope: TimeRange,
    page_size: int = 100,
    session: SessionArg = None,
) -> AsyncIterator[list[dict[str, Any]]]:
    """Stream message pages for a channel-day.

    Walks ``/channels/<id>/messages?after=<snowflake>&limit=N``
    forward through the day, stopping when messages exceed the
    end-of-day snowflake.

    Args:
        config (DiscordConfig): Discord credentials.
        channel_id (str): channel ID.
        date_str (str): YYYY-MM-DD.
        scope (TimeRange): the mount's time scope, clipping the day.
        page_size (int): per-page limit (Discord caps at 100).
        session (SessionArg): pool or live session to ride.

    Yields:
        list[dict]: message dicts, filtered to within the date.
    """
    start, end = scope.day_bounds(date_str)
    if start >= end:
        return
    first = snowflake_at(start)
    before_int = snowflake_at(end)
    after = str(max(0, first - 1))
    async for page in after_id_pages(
        config,
        f"/channels/{channel_id}/messages",
        base_params={},
        last_id_fn=lambda m: m["id"],
        page_size=page_size,
        start_after=after,
        newest_first=True,
        session=session,
    ):
        in_range = [m for m in page if first <= int(m["id"]) < before_int]
        if in_range:
            yield in_range
        if any(int(m["id"]) >= before_int for m in page):
            return


async def list_messages_for_day(
    config: DiscordConfig,
    channel_id: str,
    date_str: str,
    scope: TimeRange,
    page_size: int = 100,
    session: SessionArg = None,
) -> list[dict[str, Any]]:
    """List all messages for a channel-day (eager).

    Args:
        config (DiscordConfig): Discord credentials.
        channel_id (str): channel ID.
        date_str (str): YYYY-MM-DD.
        scope (TimeRange): the mount's time scope, clipping the day.
        page_size (int): per-page limit.
        session (SessionArg): pool or live session to ride.

    Returns:
        list[dict]: messages within the date, sorted oldest-first.
    """
    out: list[dict[str, Any]] = []
    async for page in stream_messages_for_day(
        config, channel_id, date_str, scope, page_size, session=session
    ):
        out.extend(page)
    out.sort(key=lambda m: int(m["id"]))
    return out


async def get_history_jsonl(
    config: DiscordConfig,
    channel_id: str,
    date_str: str,
    scope: TimeRange,
    session: SessionArg = None,
) -> bytes:
    """Fetch channel messages for a date as JSONL.

    Args:
        config (DiscordConfig): Discord credentials.
        channel_id (str): channel ID.
        date_str (str): date in YYYY-MM-DD format.
        scope (TimeRange): the mount's time scope, clipping the day.
        session (SessionArg): pool or live session to ride.

    Returns:
        bytes: JSONL-encoded messages.
    """
    messages = await list_messages_for_day(
        config, channel_id, date_str, scope, session=session
    )
    return history_jsonl_bytes(messages)


async def fetch_recent_messages(
    config: DiscordConfig,
    channel_id: str,
    limit: int = 20,
    session: SessionArg = None,
) -> list[dict[str, Any]]:
    """Fetch the most recent messages of a channel (one API page).

    Args:
        config (DiscordConfig): Discord credentials.
        channel_id (str): channel ID.
        limit (int): maximum number of messages (Discord caps at 100).
        session (SessionArg): pool or live session to ride.

    Returns:
        list[dict]: messages sorted oldest-first.
    """
    page = await discord_get(
        config,
        f"/channels/{channel_id}/messages",
        {"limit": limit},
        session=session,
    )
    items = (
        [m for m in page if isinstance(m, dict)]
        if isinstance(page, list)
        else []
    )
    items.sort(key=lambda m: int(m["id"]))
    return items
