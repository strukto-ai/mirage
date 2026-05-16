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

from datetime import datetime, timedelta, timezone

from mirage.accessor.discord import DiscordAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.discord.channels import list_channels
from mirage.core.discord.entry import (channel_entry, guild_entry,
                                       history_entry, member_entry,
                                       snowflake_to_date)
from mirage.core.discord.guilds import list_guilds
from mirage.core.discord.members import list_members
from mirage.types import PathSpec


def _date_range(end_date: str, days: int = 30) -> list[str]:
    end = datetime.strptime(end_date, "%Y-%m-%d").date()
    return [(end - timedelta(days=i)).isoformat()
            for i in range(days - 1, -1, -1)]


def _normalize_path(path: PathSpec | str) -> tuple[str, str, str]:
    """Reduce input to (prefix, key, virtual_key)."""
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    prefix = path.prefix
    raw = path.directory if path.pattern else path.original
    if prefix and raw.startswith(prefix):
        raw = raw[len(prefix):] or "/"
    key = raw.strip("/")
    virtual_key = prefix + "/" + key if key else prefix or "/"
    return prefix, key, virtual_key


async def _readdir_root(
    accessor: DiscordAccessor,
    prefix: str,
    virtual_key: str,
    index: IndexCacheStore | None,
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
    index: IndexCacheStore | None,
    raw_path: str,
) -> str:
    """Resolve guild snowflake from its vfs_name, bootstrapping if needed."""
    if index is None:
        raise FileNotFoundError(raw_path)
    guild_virtual_key = prefix + "/" + guild_part
    lookup = await index.get(guild_virtual_key)
    if lookup.entry is None:
        root = PathSpec(
            original=prefix or "/",
            directory=prefix or "/",
            prefix=prefix,
        )
        await _readdir_root(accessor, prefix, prefix or "/", index)
        lookup = await index.get(guild_virtual_key)
        _ = root
    if lookup.entry is None:
        raise FileNotFoundError(raw_path)
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
    index: IndexCacheStore | None,
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
    index: IndexCacheStore | None,
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


async def _readdir_channel_dates(
    accessor: DiscordAccessor,
    prefix: str,
    key: str,
    virtual_key: str,
    parts: list[str],
    index: IndexCacheStore | None,
    raw_path: str,
) -> list[str]:
    if index is None:
        last_msg_id = ""
    else:
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries
        ch_lookup = await index.get(virtual_key)
        if ch_lookup.entry is None:
            parent = PathSpec(
                original=prefix + "/" + "/".join(parts[:2]),
                directory=prefix + "/" + "/".join(parts[:2]),
                prefix=prefix,
            )
            await _readdir_channels(accessor, prefix, "/".join(parts[:2]),
                                    prefix + "/" + "/".join(parts[:2]),
                                    parts[:2], index, raw_path)
            ch_lookup = await index.get(virtual_key)
            _ = parent
        if ch_lookup.entry is None:
            raise FileNotFoundError(raw_path)
        last_msg_id = ch_lookup.entry.remote_time
    if last_msg_id:
        end_date = snowflake_to_date(last_msg_id)
    else:
        end_date = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")
    dates = _date_range(end_date)
    entries = []
    names = []
    for d in dates:
        entry = history_entry(key, d)
        entries.append((entry.vfs_name, entry))
        names.append(f"{prefix}/{key}/{entry.vfs_name}")
    if index is not None:
        await index.set_dir(virtual_key, entries)
    return names


async def readdir(
    accessor: DiscordAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> list[str]:
    """List directory contents.

    Args:
        accessor (DiscordAccessor): discord accessor.
        path (PathSpec | str): resource-relative path.
        index (IndexCacheStore | None): index cache.
    """
    prefix, key, virtual_key = _normalize_path(path)
    raw_path = path.original if isinstance(path, PathSpec) else path

    if not key:
        return await _readdir_root(accessor, prefix, virtual_key, index)

    parts = key.split("/")

    if len(parts) == 1:
        if index is not None:
            lookup = await index.get(virtual_key)
            if lookup.entry is None:
                raise FileNotFoundError(raw_path)
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

    return []
