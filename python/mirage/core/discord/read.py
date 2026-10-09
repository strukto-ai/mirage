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
from contextlib import aclosing

from mirage.accessor.discord import DiscordAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.discord.files import download_file, download_file_stream
from mirage.core.discord.history import get_history_jsonl
from mirage.core.discord.members import list_members
from mirage.core.discord.readdir import readdir
from mirage.core.discord.render import member_json_bytes
from mirage.core.discord.scope import detect_scope
from mirage.core.hierarchy.probe import resolve_entry
from mirage.core.hierarchy.read import make_read, make_read_range
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.time_range import day_channel_id, guard_day
from mirage.errors.fs import enoent
from mirage.io.cooperative import chunks
from mirage.types import PathSpec


async def _read_chat(
    accessor: DiscordAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
) -> bytes:
    await guard_day(accessor, match, path.virtual)
    channel_id = await day_channel_id(readdir, accessor, path, index)
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
    index: IndexCacheStore,
) -> bytes:
    entry = await resolve_entry(readdir, accessor, path, index)
    if entry is None:
        raise enoent(path.virtual)
    members = await list_members(
        accessor.config, match.slots["guild_id"], session=accessor.pool
    )
    for m in members:
        user = m.get("user", {})
        if user.get("id") == entry.id:
            return member_json_bytes(m)
    raise enoent(path.virtual)


async def _blob_url(
    accessor: DiscordAccessor, path: PathSpec, index: IndexCacheStore
) -> str:
    await guard_day(accessor, detect_scope(path), path.virtual)
    entry = await resolve_entry(readdir, accessor, path, index)
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
    index: IndexCacheStore,
) -> bytes:
    return await download_file(
        await _blob_url(accessor, path, index), 0, None, session=accessor.pool
    )


async def _read_blob_range(
    accessor: DiscordAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
    offset: int,
    size: int | None,
) -> bytes:
    return await download_file(
        await _blob_url(accessor, path, index),
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
    index: IndexCacheStore = NULL_INDEX,
) -> AsyncGenerator[bytes, None]:
    """Stream attachments; preserve the rendered order of JSON records.

    Args:
        accessor (DiscordAccessor): backend accessor.
        path (PathSpec): file to read.
        index (IndexCacheStore): cached directory entries.
    """
    if detect_scope(path).kind == "file_blob":
        url = await _blob_url(accessor, path, index)
        source = download_file_stream(url, session=accessor.pool)
    else:
        source = chunks(await read(accessor, path, index))
    async with aclosing(source):
        async for chunk in source:
            yield chunk
