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

from mirage.accessor.slack import SlackAccessor
from mirage.core.hierarchy.read import make_read, make_read_range, per_kind
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.slack.client import download_file, download_file_stream
from mirage.core.slack.history import (
    fetch_messages_for_day,
    get_history_jsonl,
    stream_messages_for_day,
)
from mirage.core.slack.readdir import readdir
from mirage.core.slack.scope import detect_scope
from mirage.core.slack.users import get_user_profile, user_json_bytes
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
    accessor: SlackAccessor,
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


async def _read_user(
    accessor: SlackAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    if entry is None:
        raise enoent(path.virtual)
    user = await get_user_profile(
        accessor.config, str(entry.extra["user_id"]), session=accessor.pool
    )
    return user_json_bytes(user)


async def _blob_url(
    accessor: SlackAccessor, path: PathSpec, entry: FileStat | None
) -> str:
    await guard_day(accessor, detect_scope(path), path.virtual)
    if entry is None:
        raise enoent(path.virtual)
    url = entry.extra.get("url_private_download")
    if not isinstance(url, str) or not url:
        raise enoent(path.virtual)
    return url


async def _read_blob(
    accessor: SlackAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    url = await _blob_url(accessor, path, entry)
    return await download_file(
        accessor.config, url, 0, None, session=accessor.pool
    )


async def _read_blob_range(
    accessor: SlackAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
    offset: int,
    size: int | None,
) -> bytes:
    url = await _blob_url(accessor, path, entry)
    return await download_file(
        accessor.config, url, offset, size, session=accessor.pool
    )


read = make_read(
    detect_scope,
    readers={
        "messages": _read_chat,
        "user": _read_user,
        "file_blob": _read_blob,
    },
)

# Only an uploaded file has a remote range to ask for. A channel's
# history and a user profile are rendered here into JSON, so their bytes
# do not exist until we make them and the window can only be taken
# afterwards.
read_range = make_read_range(
    detect_scope,
    read,
    ranged={"file_blob": _read_blob_range},
)


async def read_stream(
    accessor: SlackAccessor,
    path: PathSpec,
    entry: FileStat | None = None,
    parent: FileStat | None = None,
) -> AsyncGenerator[bytes, None]:
    """Stream attachments; preserve the rendered order of JSON records.

    Args:
        accessor (SlackAccessor): backend accessor.
        path (PathSpec): file to read.
        entry (FileStat | None): the file's row, as its listing names it.
        parent (FileStat | None): its folder's row.
    """
    if detect_scope(path).kind == "file_blob":
        url = await _blob_url(accessor, path, entry)
        source = download_file_stream(
            accessor.config, url, session=accessor.pool
        )
    else:
        source = chunks(await read(accessor, path, entry, parent))
    async with aclosing(source):
        async for chunk in source:
            yield chunk


async def _follow_chat(
    accessor: SlackAccessor,
    match: ScopeMatch,
    path: PathSpec,
    n: int,
    interval: float,
    entry: FileStat | None = None,
    parent: FileStat | None = None,
) -> AsyncIterator[bytes]:
    """A channel or DM day's last ``n`` messages, then each one posted to it,
    asked for every ``interval`` seconds while the day lasts
    (``followed_day``).

    Args:
        accessor (SlackAccessor): backend accessor.
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
        fetch_messages_for_day,
        accessor.config,
        channel_id,
        day,
        accessor.time_range,
        session=accessor.pool,
    )

    async def after(last: dict[str, Any] | None) -> list[dict[str, Any]]:
        return await fetch(after=None if last is None else last["ts"])

    _, end = accessor.time_range.day_bounds(day)
    return followed_day(await fetch(), n, end, interval, after)


follow = per_kind(detect_scope, {"messages": _follow_chat})


def _run_pages(
    accessor: SlackAccessor, channel_id: str, first: str, last: str
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
    return float(message.get("ts", "0"))


def _posted_within(message: dict[str, Any], start: float, end: float) -> bool:
    return start <= float(message["ts"]) < end


async def read_many(
    accessor: SlackAccessor,
    paths: list[PathSpec],
    limit: int,
    index: IndexCacheStore = NULL_INDEX,
) -> dict[str, bytes]:
    """Several chat.jsonl files, one history walk per run of a channel's
    consecutive days (``read_days``).

    Args:
        accessor (SlackAccessor): backend accessor.
        paths (list[PathSpec]): the files.
        limit (int): the most bytes worth reading for one day.
        index (IndexCacheStore): cached directory entries.
    """
    return await read_days(
        readdir,
        accessor,
        accessor.time_range,
        paths,
        index,
        detect_scope,
        partial(_run_pages, accessor),
        _sort_key,
        _posted_within,
        limit,
    )
