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

import logging
from datetime import datetime, timedelta, timezone

import aiohttp

from mirage.accessor.discord import DiscordAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.discord.channels import list_channels
from mirage.core.discord.entry import (DiscordResourceType, channel_entry,
                                       guild_entry, history_entry,
                                       member_entry, snowflake_to_date)
from mirage.core.discord.files import file_blob_name
from mirage.core.discord.guilds import list_guilds
from mirage.core.discord.history import list_messages_for_day
from mirage.core.discord.members import list_members
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of

logger = logging.getLogger(__name__)

SOFT_HTTP_STATUSES = frozenset((403, 404, 429))


def _is_soft_error(exc: Exception) -> bool:
    return (isinstance(exc, aiohttp.ClientResponseError)
            and exc.status in SOFT_HTTP_STATUSES)


def _date_range(end_date: str, days: int = 30) -> list[str]:
    end = datetime.strptime(end_date, "%Y-%m-%d").date()
    return [(end - timedelta(days=i)).isoformat()
            for i in range(days - 1, -1, -1)]


def _normalize_path(path: PathSpec | str) -> tuple[str, str, str]:
    """Reduce input to (prefix, key, virtual_key)."""
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    raw = path.directory if path.pattern else path.virtual
    if prefix and raw.startswith(prefix):
        raw = raw[len(prefix):] or "/"
    key = raw.strip("/")
    virtual_key = prefix + "/" + key if key else prefix or "/"
    return prefix, key, virtual_key


async def _readdir_root(
    accessor: DiscordAccessor,
    prefix: str,
    virtual_key: str,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    if index is not None:
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries
    guilds = await list_guilds(accessor.config)
    entries = []
    names = []
    for g in guilds:
        entry = guild_entry(g)
        entries.append((entry.vfs_name, entry))
        names.append(f"{prefix}/{entry.vfs_name}")
    if index is not None:
        await index.set_dir(virtual_key, entries)
    return names


async def _ensure_guild_id(
    accessor: DiscordAccessor,
    prefix: str,
    guild_part: str,
    index: IndexCacheStore,
    raw_path: str,
) -> str:
    guild_virtual_key = prefix + "/" + guild_part
    lookup = await index.get(guild_virtual_key)
    if lookup.entry is None:
        await _readdir_root(accessor, prefix, prefix or "/", index)
        lookup = await index.get(guild_virtual_key)
    if lookup.entry is None:
        raise enoent(raw_path)
    return lookup.entry.id


async def _readdir_guild_top(
    prefix: str,
    key: str,
) -> list[str]:
    return [f"{prefix}/{key}/channels", f"{prefix}/{key}/members"]


async def _readdir_channels(
    accessor: DiscordAccessor,
    prefix: str,
    key: str,
    virtual_key: str,
    parts: list[str],
    index: IndexCacheStore,
    raw_path: str,
) -> list[str]:
    if index is not None:
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries
    guild_id = await _ensure_guild_id(accessor, prefix, parts[0], index,
                                      raw_path)
    channels = await list_channels(accessor.config, guild_id)
    entries = []
    names = []
    for c in channels:
        entry = channel_entry(c)
        entries.append((entry.vfs_name, entry))
        names.append(f"{prefix}/{key}/{entry.vfs_name}")
    if index is not None:
        await index.set_dir(virtual_key, entries)
    return names


async def _readdir_members(
    accessor: DiscordAccessor,
    prefix: str,
    key: str,
    virtual_key: str,
    parts: list[str],
    index: IndexCacheStore,
    raw_path: str,
) -> list[str]:
    if index is not None:
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries
    guild_id = await _ensure_guild_id(accessor, prefix, parts[0], index,
                                      raw_path)
    members = await list_members(accessor.config, guild_id)
    entries = []
    names = []
    for m in members:
        entry = member_entry(m)
        entries.append((entry.vfs_name, entry))
        names.append(f"{prefix}/{key}/{entry.vfs_name}")
    if index is not None:
        await index.set_dir(virtual_key, entries)
    return names


async def _ensure_channel_lookup(
    accessor: DiscordAccessor,
    prefix: str,
    parts: list[str],
    index: IndexCacheStore,
    raw_path: str,
):
    channel_vk = f"{prefix}/{'/'.join(parts[:3])}"
    lookup = await index.get(channel_vk)
    if lookup.entry is None:
        await _readdir_channels(accessor, prefix, "/".join(parts[:2]),
                                f"{prefix}/{'/'.join(parts[:2])}", parts[:2],
                                index, raw_path)
        lookup = await index.get(channel_vk)
    if lookup.entry is None:
        raise enoent(raw_path)
    return lookup


async def _readdir_channel_dates(
    accessor: DiscordAccessor,
    prefix: str,
    key: str,
    virtual_key: str,
    parts: list[str],
    index: IndexCacheStore,
    raw_path: str,
) -> list[str]:
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    lookup = await _ensure_channel_lookup(accessor, prefix, parts, index,
                                          raw_path)
    last_msg_id = lookup.entry.remote_time
    if last_msg_id:
        end_date = snowflake_to_date(last_msg_id)
    else:
        end_date = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")
    dates = _date_range(end_date)
    entries = []
    names = []
    for d in dates:
        entry = history_entry(key, d)
        entry.resource_type = DiscordResourceType.HISTORY
        entry.vfs_name = d
        entries.append((d, entry))
        names.append(f"{prefix}/{key}/{d}")
    if index is not None:
        await index.set_dir(virtual_key, entries)
    return names


async def _fetch_day(
    accessor: DiscordAccessor,
    channel_id: str,
    date_str: str,
    date_vkey: str,
    index: IndexCacheStore = NULL_INDEX,
) -> None:
    """Walk the day's history once, populate date dir and files dir
    entries in the index. Tolerates soft HTTP errors (403/404/429) by
    sealing an empty date dir.
    """
    try:
        messages = await list_messages_for_day(accessor.config, channel_id,
                                               date_str)
    except aiohttp.ClientResponseError as e:
        if _is_soft_error(e):
            logger.debug("discord: history denied for %s/%s (%d); empty day",
                         channel_id, date_str, e.status)
            await index.set_dir(date_vkey, [])
            return
        raise
    chat_entry = IndexEntry(
        id=f"{channel_id}:{date_str}:chat",
        name="chat.jsonl",
        resource_type="discord/chat_jsonl",
        vfs_name="chat.jsonl",
    )
    files_entry = IndexEntry(
        id=f"{channel_id}:{date_str}:files",
        name="files",
        resource_type="discord/files_dir",
        vfs_name="files",
    )
    await index.set_dir(date_vkey, [
        ("chat.jsonl", chat_entry),
        ("files", files_entry),
    ])
    file_entries: list[tuple[str, IndexEntry]] = []
    for msg in messages:
        for att in msg.get("attachments") or []:
            if not att.get("id"):
                continue
            blob_name = file_blob_name(att)
            file_entries.append((blob_name,
                                 IndexEntry(
                                     id=str(att["id"]),
                                     name=att.get("filename") or "",
                                     resource_type="discord/file",
                                     vfs_name=blob_name,
                                     size=att.get("size"),
                                     extra={
                                         "url":
                                         att.get("url", ""),
                                         "proxy_url":
                                         att.get("proxy_url", ""),
                                         "content_type":
                                         att.get("content_type", ""),
                                         "message_id":
                                         msg.get("id", ""),
                                         "author":
                                         msg.get("author",
                                                 {}).get("username", ""),
                                         "channel_id":
                                         channel_id,
                                         "date":
                                         date_str,
                                     },
                                 )))
    await index.set_dir(f"{date_vkey}/files", file_entries)


async def _readdir_date_contents(
    accessor: DiscordAccessor,
    prefix: str,
    key: str,
    virtual_key: str,
    parts: list[str],
    index: IndexCacheStore,
    raw_path: str,
) -> list[str]:
    cached = await index.list_dir(virtual_key)
    if cached.entries is not None:
        return cached.entries
    lookup = await _ensure_channel_lookup(accessor, prefix, parts, index,
                                          raw_path)
    await _fetch_day(accessor, lookup.entry.id, parts[3], virtual_key, index)
    cached = await index.list_dir(virtual_key)
    if cached.entries is None:
        raise enoent(raw_path)
    return cached.entries


async def _readdir_files_dir(
    accessor: DiscordAccessor,
    prefix: str,
    key: str,
    virtual_key: str,
    parts: list[str],
    index: IndexCacheStore,
    raw_path: str,
) -> list[str]:
    cached = await index.list_dir(virtual_key)
    if cached.entries is not None:
        return cached.entries
    # Date dir lookup triggers _fetch_day which populates the files dir
    date_key = "/".join(parts[:4])
    date_vk = f"{prefix}/{date_key}"
    date_spec = PathSpec(virtual=date_vk,
                         directory=date_vk,
                         resource_path=mount_key(date_vk, prefix))
    await readdir(accessor, date_spec, index)
    cached = await index.list_dir(virtual_key)
    if cached.entries is None:
        raise enoent(raw_path)
    return cached.entries


async def readdir(
    accessor: DiscordAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    """List directory contents.

    Args:
        accessor (DiscordAccessor): discord accessor.
        path (PathSpec | str): resource-relative path.
        index (IndexCacheStore | None): index cache.
    """
    prefix, key, virtual_key = _normalize_path(path)
    raw_path = path.virtual if isinstance(path, PathSpec) else path

    if not key:
        return await _readdir_root(accessor, prefix, virtual_key, index)

    parts = key.split("/")

    if len(parts) == 1:
        if index is not None:
            lookup = await index.get(virtual_key)
            if lookup.entry is None:
                raise enoent(raw_path)
        return await _readdir_guild_top(prefix, key)

    if len(parts) == 2 and parts[1] == "channels":
        return await _readdir_channels(accessor, prefix, key, virtual_key,
                                       parts, index, raw_path)

    if len(parts) == 2 and parts[1] == "members":
        return await _readdir_members(accessor, prefix, key, virtual_key,
                                      parts, index, raw_path)

    if len(parts) == 3 and parts[1] == "channels":
        return await _readdir_channel_dates(accessor, prefix, key, virtual_key,
                                            parts, index, raw_path)

    if len(parts) == 4 and parts[1] == "channels":
        return await _readdir_date_contents(accessor, prefix, key, virtual_key,
                                            parts, index, raw_path)

    if (len(parts) == 5 and parts[1] == "channels" and parts[4] == "files"):
        return await _readdir_files_dir(accessor, prefix, key, virtual_key,
                                        parts, index, raw_path)

    return []


def is_dir_name(child: str) -> bool:
    # Entries are recognized by extension, so classification never needs
    # the stat fallback.
    name = child.rsplit("/", 1)[-1]
    return not (name.endswith(".json") or name.endswith(".jsonl"))
