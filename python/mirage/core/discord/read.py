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

from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import aclosing
from functools import partial
from typing import Any

from mirage.accessor.discord import DiscordAccessor
from mirage.core.discord.files import download_file, download_file_stream
from mirage.core.discord.history import (
    get_history_jsonl,
    list_messages_for_day,
    snowflake_at,
    stream_messages_for_day,
)
from mirage.core.discord.members import list_members
from mirage.core.discord.scope import detect_scope
from mirage.core.hierarchy.read import make_read, make_read_range, per_kind
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.render.json import compact_json_bytes
from mirage.core.time_range import (
    day_channel_id,
    followed_day,
    guard_day,
    read_days,
)
from mirage.errors.fs import enoent
from mirage.io.cooperative import chunks
from mirage.types import FileStat, PathSpec


async def _read_chat(
    accessor: DiscordAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    await guard_day(accessor, match, path.virtual)
    channel_id = day_channel_id(path, entry, parent)
    return await get_history_jsonl(
        accessor.config,
        channel_id,
        match.slots["day"],
        accessor.time_range,
        session=accessor.pool,
    )


async def _read_member(
    accessor: DiscordAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    if entry is None:
        raise enoent(path.virtual)
    members = await list_members(
        accessor.config, match.slots["guild_id"], session=accessor.pool
    )
    for m in members:
        user = m.get("user", {})
        if user.get("id") == entry.extra.get("user_id"):
            return compact_json_bytes(m)
    raise enoent(path.virtual)


async def _blob_url(
    accessor: DiscordAccessor, path: PathSpec, entry: FileStat | None
) -> str:
    await guard_day(accessor, detect_scope(path), path.virtual)
    if entry is None:
        raise enoent(path.virtual)
    url = entry.extra.get("url") or entry.extra.get("proxy_url") or ""
    if not url:
        raise enoent(path.virtual)
    return url


async def _read_blob(
    accessor: DiscordAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    return await download_file(
        await _blob_url(accessor, path, entry), 0, None, session=accessor.pool
    )


async def _read_blob_range(
    accessor: DiscordAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
    offset: int,
    size: int | None,
) -> bytes:
    return await download_file(
        await _blob_url(accessor, path, entry),
        offset,
        size,
        session=accessor.pool,
    )


read = make_read(
    detect_scope,
    readers={
        "messages": _read_chat,
        "member": _read_member,
        "file_blob": _read_blob,
    },
)

# Only an attachment has a remote range to ask for. A channel's history
# and a member profile are rendered here into JSON, so their bytes do
# not exist until we make them and the window can only be taken
# afterwards.
read_range = make_read_range(
    detect_scope,
    read,
    ranged={"file_blob": _read_blob_range},
)


async def read_stream(
    accessor: DiscordAccessor,
    path: PathSpec,
    entry: FileStat | None = None,
    parent: FileStat | None = None,
) -> AsyncGenerator[bytes, None]:
    """Stream attachments; preserve the rendered order of JSON records.

    Args:
        accessor (DiscordAccessor): backend accessor.
        path (PathSpec): file to read.
        entry (FileStat | None): the file's row, as its listing names it.
        parent (FileStat | None): its folder's row.
    """
    if detect_scope(path).kind == "file_blob":
        url = await _blob_url(accessor, path, entry)
        source = download_file_stream(url, session=accessor.pool)
    else:
        source = chunks(await read(accessor, path, entry, parent))
    async with aclosing(source):
        async for chunk in source:
            yield chunk


async def _follow_chat(
    accessor: DiscordAccessor,
    match: ScopeMatch,
    path: PathSpec,
    n: int,
    interval: float,
    entry: FileStat | None = None,
    parent: FileStat | None = None,
) -> AsyncIterator[bytes]:
    """A channel day's last ``n`` messages, then each one posted to it,
    asked for every ``interval`` seconds while the day lasts
    (``followed_day``).

    Args:
        accessor (DiscordAccessor): backend accessor.
        match (ScopeMatch): the chat.jsonl's match.
        path (PathSpec): the chat.jsonl.
        n (int): how many of its last lines come first, 0 for none.
        interval (float): seconds between two asks.
        entry (FileStat | None): the file's row, as its day lists it.
        parent (FileStat | None): the day's row.
    """
    await guard_day(accessor, match, path.virtual)
    channel_id = day_channel_id(path, entry, parent)
    day = match.slots["day"]
    fetch = partial(
        list_messages_for_day,
        accessor.config,
        channel_id,
        day,
        accessor.time_range,
        session=accessor.pool,
    )

    async def after(last: dict[str, Any] | None) -> list[dict[str, Any]]:
        return await fetch(after=None if last is None else last["id"])

    _, end = accessor.time_range.day_bounds(day)
    return followed_day(await fetch(), n, end, interval, after)


follow = per_kind(detect_scope, {"messages": _follow_chat})


def _run_pages(
    accessor: DiscordAccessor, channel_id: str, first: str, last: str
) -> AsyncGenerator[list[dict[str, Any]], None]:
    return stream_messages_for_day(
        accessor.config,
        channel_id,
        first,
        accessor.time_range,
        session=accessor.pool,
        last_day=last,
    )


def _sort_key(message: dict[str, Any]) -> float:
    return int(message["id"])


def _posted_within(message: dict[str, Any], start: float, end: float) -> bool:
    return snowflake_at(start) <= int(message["id"]) < snowflake_at(end)


async def read_many(
    accessor: DiscordAccessor,
    paths: list[PathSpec],
    limit: int,
    entries: list[FileStat | None],
    parents: list[FileStat | None],
) -> dict[str, bytes]:
    """Several chat.jsonl files, one history walk per run of a channel's
    consecutive days (``read_days``).

    Args:
        accessor (DiscordAccessor): backend accessor.
        paths (list[PathSpec]): the files.
        limit (int): the most bytes worth reading for one day.
        entries (list[FileStat | None]): what is at each path, as its
            day's listing names it.
        parents (list[FileStat | None]): each path's day.
    """
    return await read_days(
        accessor.time_range,
        paths,
        entries,
        parents,
        detect_scope,
        partial(_run_pages, accessor),
        _sort_key,
        _posted_within,
        limit,
    )
