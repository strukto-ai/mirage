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

from collections.abc import AsyncGenerator
from functools import partial
from typing import Any

from mirage.accessor.discord import DiscordAccessor
from mirage.cache.index.scope import sole_command_started
from mirage.core.discord.client import discord_get
from mirage.core.discord.paginate import after_id_pages
from mirage.core.render.json import jsonl_bytes
from mirage.core.time_range import TimeRange

DISCORD_EPOCH = 1420070400000


def snowflake_at(seconds: float) -> int:
    """The lowest snowflake Discord mints at ``seconds`` of Unix time.

    Args:
        seconds (float): Unix time.
    """
    return (round(seconds * 1000) - DISCORD_EPOCH) << 22


async def stream_messages_for_day(
    accessor: DiscordAccessor,
    channel_id: str,
    date_str: str,
    scope: TimeRange,
    page_size: int = 100,
    after: str | None = None,
    last_day: str | None = None,
) -> AsyncGenerator[list[dict[str, Any]], None]:
    """Stream message pages for a channel-day, or a run of days.

    Walks ``/channels/<id>/messages?after=<snowflake>&limit=N``
    forward through the day, stopping when messages exceed the
    end-of-day snowflake.

    Args:
        accessor (DiscordAccessor): Discord accessor.
        channel_id (str): channel ID.
        date_str (str): YYYY-MM-DD.
        scope (TimeRange): the mount's time scope, clipping the day.
        page_size (int): per-page limit (Discord caps at 100).
        after (str | None): only the messages after this id.
        last_day (str | None): the last day of a run read as one, the
            day itself when None.

    Yields:
        list[dict]: message dicts, filtered to within the date.
    """
    start, _ = scope.day_bounds(date_str)
    _, end = scope.day_bounds(last_day or date_str)
    if start >= end:
        return
    first = snowflake_at(start)
    before_int = snowflake_at(end)
    floor = max(0, first - 1, int(after) if after is not None else 0)
    async for page in after_id_pages(
        accessor,
        f"/channels/{channel_id}/messages",
        base_params={},
        last_id_fn=lambda m: m["id"],
        page_size=page_size,
        start_after=str(floor),
        newest_first=True,
    ):
        in_range = [m for m in page if first <= int(m["id"]) < before_int]
        if in_range:
            yield in_range
        if any(int(m["id"]) >= before_int for m in page):
            return


async def list_messages_for_day(
    accessor: DiscordAccessor,
    channel_id: str,
    date_str: str,
    scope: TimeRange,
    page_size: int = 100,
    after: str | None = None,
) -> list[dict[str, Any]]:
    """List all messages for a channel-day (eager).

    Args:
        accessor (DiscordAccessor): Discord accessor.
        channel_id (str): channel ID.
        date_str (str): YYYY-MM-DD.
        scope (TimeRange): the mount's time scope, clipping the day.
        page_size (int): per-page limit.
        after (str | None): only the messages after this id.

    Returns:
        list[dict]: messages within the date, sorted oldest-first.
    """
    out: list[dict[str, Any]] = []
    async for page in stream_messages_for_day(
        accessor, channel_id, date_str, scope, page_size, after=after
    ):
        out.extend(page)
    out.sort(key=lambda m: int(m["id"]))
    return out


async def _kept_day(
    accessor: DiscordAccessor, channel_id: str, date_str: str
) -> list[dict[str, Any]]:
    """A channel-day's messages: the ones the running command already
    fetched, else fetched now and kept for that command. Outside any
    command nothing is kept, since no command bounds how long the day
    would be served.

    Args:
        accessor (DiscordAccessor): Discord accessor.
        channel_id (str): channel ID.
        date_str (str): YYYY-MM-DD.
    """
    fetch = partial(
        list_messages_for_day,
        accessor,
        channel_id,
        date_str,
        accessor.time_range,
    )
    started = sole_command_started()
    if started is None:
        return await fetch()
    return await accessor.listed_day.get(
        (started, channel_id, date_str), fetch
    )


async def listed_messages_for_day(
    accessor: DiscordAccessor, channel_id: str, date_str: str
) -> list[dict[str, Any]]:
    """A channel-day's messages for its listing, kept for the read of its
    chat.jsonl that follows in the same command.

    A walk reads a day's chat.jsonl right after it lists the day, so only
    the last listed day is kept, only for the command that listed it, and
    for at most ``LISTING_TRUST_WINDOW`` seconds, the window a fetch
    still counts as current in (none under ``fresh``). That command's
    read takes it instead of fetching the day again; any other read, a
    direct one included, asks Discord. A listing nothing reads holds no
    more than one day.

    Args:
        accessor (DiscordAccessor): Discord accessor.
        channel_id (str): channel ID.
        date_str (str): YYYY-MM-DD.
    """
    accessor.listed_day.clear()
    return await _kept_day(accessor, channel_id, date_str)


async def get_history_jsonl(
    accessor: DiscordAccessor, channel_id: str, date_str: str
) -> bytes:
    """A channel-day's messages as JSONL: the ones the running command's
    listing of the day just fetched (``listed_messages_for_day``), else
    fetched now. Either way the day is no longer kept.

    Args:
        accessor (DiscordAccessor): Discord accessor.
        channel_id (str): channel ID.
        date_str (str): date in YYYY-MM-DD format.

    Returns:
        bytes: JSONL-encoded messages.
    """
    messages = await _kept_day(accessor, channel_id, date_str)
    accessor.listed_day.clear()
    return jsonl_bytes(messages)


async def fetch_recent_messages(
    accessor: DiscordAccessor, channel_id: str, limit: int = 20
) -> list[dict[str, Any]]:
    """Fetch the most recent messages of a channel (one API page).

    Args:
        accessor (DiscordAccessor): Discord accessor.
        channel_id (str): channel ID.
        limit (int): maximum number of messages (Discord caps at 100).

    Returns:
        list[dict]: messages sorted oldest-first.
    """
    page = await discord_get(
        accessor, f"/channels/{channel_id}/messages", {"limit": limit}
    )
    items = (
        [m for m in page if isinstance(m, dict)]
        if isinstance(page, list)
        else []
    )
    items.sort(key=lambda m: int(m["id"]))
    return items
