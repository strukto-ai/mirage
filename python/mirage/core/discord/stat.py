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

from mirage.accessor.discord import DiscordAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.discord.entry import snowflake_to_iso
from mirage.core.discord.readdir import readdir
from mirage.core.discord.scope import detect_scope
from mirage.core.hierarchy.probe import resolve_entry
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import entry_stat, make_stat
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import content_type_for_mime
from mirage.utils.key_prefix import mount_key, mount_prefix_of


def _dir_stat(match: ScopeMatch, path: PathSpec,
              entry: IndexEntry) -> FileStat:
    return FileStat(name=entry.vfs_name, type=FileType.DIRECTORY)


def _guild_stat(match: ScopeMatch, path: PathSpec,
                entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name or entry.name,
        type=FileType.DIRECTORY,
        extra={"guild_id": entry.id},
    )


def _channel_stat(match: ScopeMatch, path: PathSpec,
                  entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name or entry.name,
        type=FileType.DIRECTORY,
        modified=snowflake_to_iso(entry.remote_time),
        extra={"channel_id": entry.id},
    )


def _file_blob_stat(match: ScopeMatch, path: PathSpec,
                    entry: IndexEntry) -> FileStat:
    mimetype = entry.extra.get("content_type", "")
    return FileStat(
        name=entry.vfs_name or entry.name,
        size=entry.size,
        type=FileType.FILE,
        content=content_type_for_mime(mimetype),
        extra={
            "content_type": mimetype,
            "attachment_id": entry.id,
        },
    )


async def _channel_proven(accessor: DiscordAccessor, path: PathSpec,
                          index: IndexCacheStore, up: int) -> None:
    """Raise ENOENT unless the path's channel ancestor exists.

    Args:
        accessor (DiscordAccessor): discord accessor.
        path (PathSpec): the day or chat.jsonl path being stat'd.
        index (IndexCacheStore): index cache.
        up (int): how many trailing segments to drop to reach the
            channel (1 for a day dir, 2 for its children).
    """
    virtual = path.virtual.rstrip("/")
    for _ in range(up):
        virtual = virtual.rsplit("/", 1)[0]
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    spec = PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=mount_key(virtual, prefix))
    if await resolve_entry(readdir, accessor, spec, index) is None:
        raise enoent(path.virtual)


async def _stat_day(accessor: DiscordAccessor, match: ScopeMatch,
                    path: PathSpec, index: IndexCacheStore) -> FileStat:
    """Stat a day directory, which resolves beyond the listed window.

    The channel listing synthesizes a bounded window of recent days,
    but the history API answers a range query for any date, so a
    well-formed day under a channel that exists is a directory whether
    or not the window lists it. A bogus channel chain is ENOENT.

    Args:
        accessor (DiscordAccessor): discord accessor.
        match (ScopeMatch): a match holding ``guild``/``channel``/``day``.
        path (PathSpec): the path to stat.
        index (IndexCacheStore): index cache.
    """
    entry = await resolve_entry(readdir, accessor, path, index)
    if entry is not None:
        return FileStat(name=entry.vfs_name, type=FileType.DIRECTORY)
    await _channel_proven(accessor, path, index, up=1)
    return FileStat(name=match.slots["day"], type=FileType.DIRECTORY)


async def _stat_chat(accessor: DiscordAccessor, match: ScopeMatch,
                     path: PathSpec, index: IndexCacheStore) -> FileStat:
    """Stat chat.jsonl, which survives a sealed day.

    A day whose history could not be listed (403/404/429) seals an
    empty date dir; the file still stats, with the size left unknown.

    Args:
        accessor (DiscordAccessor): discord accessor.
        match (ScopeMatch): a match holding the day chain.
        path (PathSpec): the path to stat.
        index (IndexCacheStore): index cache.
    """
    entry = await resolve_entry(readdir, accessor, path, index)
    if entry is not None:
        return FileStat(name="chat.jsonl",
                        type=FileType.FILE,
                        content=ContentType.TEXT,
                        size=entry.size)
    await _channel_proven(accessor, path, index, up=2)
    return FileStat(name="chat.jsonl",
                    type=FileType.FILE,
                    content=ContentType.TEXT,
                    size=None)


stat = make_stat(
    detect_scope,
    readdir,
    entry_stats={
        "guild": _guild_stat,
        "channels_dir": _dir_stat,
        "members_dir": _dir_stat,
        "channel": _channel_stat,
        "member": entry_stat("user_id", ContentType.JSON),
        "files": _dir_stat,
        "file_blob": _file_blob_stat,
    },
    overrides={
        "day": _stat_day,
        "messages": _stat_chat,
    },
)
