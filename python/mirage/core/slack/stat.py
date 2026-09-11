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

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.hierarchy.probe import resolve_entry
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import make_stat
from mirage.core.slack.readdir import readdir
from mirage.core.slack.scope import detect_scope
from mirage.core.timeutil import epoch_to_iso
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import content_type_for_mime
from mirage.utils.key_prefix import mount_key, mount_prefix_of


def _slack_modified(remote_time: str) -> str | None:
    if not remote_time:
        return None
    try:
        ts = float(remote_time)
    except (TypeError, ValueError):
        return None
    if ts <= 0:
        return None
    return epoch_to_iso(ts)


def _channel_stat(match: ScopeMatch, path: PathSpec,
                  entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name or entry.name,
        type=FileType.DIRECTORY,
        modified=_slack_modified(entry.remote_time),
        extra={"channel_id": entry.id},
    )


def _user_stat(match: ScopeMatch, path: PathSpec,
               entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name or entry.name,
        type=FileType.FILE,
        content=ContentType.JSON,
        size=entry.size,
        extra={"user_id": entry.id},
    )


def _dir_stat(match: ScopeMatch, path: PathSpec,
              entry: IndexEntry) -> FileStat:
    return FileStat(name=entry.vfs_name, type=FileType.DIRECTORY)


def _file_blob_stat(match: ScopeMatch, path: PathSpec,
                    entry: IndexEntry) -> FileStat:
    mimetype = entry.extra.get("mimetype", "")
    return FileStat(
        name=entry.vfs_name or entry.name,
        type=FileType.FILE,
        content=content_type_for_mime(mimetype),
        size=entry.size,
        modified=_slack_modified(entry.remote_time),
        extra={"file_id": entry.id},
    )


async def _channel_proven(accessor: SlackAccessor, path: PathSpec,
                          index: IndexCacheStore, up: int) -> None:
    """Raise ENOENT unless the path's channel ancestor exists.

    Args:
        accessor (SlackAccessor): slack accessor.
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


async def _stat_day(accessor: SlackAccessor, match: ScopeMatch, path: PathSpec,
                    index: IndexCacheStore) -> FileStat:
    """Stat a day directory, which resolves beyond the listed window.

    The channel listing synthesizes a bounded window of recent days,
    but the history API answers a range query for any date, so a
    well-formed day under a channel that exists is a directory whether
    or not the window lists it. A bogus channel chain is ENOENT.

    Args:
        accessor (SlackAccessor): slack accessor.
        match (ScopeMatch): a match holding ``container``/``channel``/
            ``day``.
        path (PathSpec): the path to stat.
        index (IndexCacheStore): index cache.
    """
    entry = await resolve_entry(readdir, accessor, path, index)
    if entry is not None:
        return FileStat(name=entry.vfs_name, type=FileType.DIRECTORY)
    await _channel_proven(accessor, path, index, up=1)
    return FileStat(name=match.slots["day"], type=FileType.DIRECTORY)


def _chat_stat(match: ScopeMatch, path: PathSpec,
               entry: IndexEntry) -> FileStat:
    # A denied or empty day lists no chat.jsonl, and the kit reports the
    # absent entry as ENOENT: slack does not fabricate a sizeless file
    # for a sealed day (discord deliberately does; see its override).
    return FileStat(name="chat.jsonl",
                    type=FileType.FILE,
                    content=ContentType.TEXT,
                    size=entry.size)


stat = make_stat(
    detect_scope,
    readdir,
    entry_stats={
        "channel": _channel_stat,
        "user": _user_stat,
        "messages": _chat_stat,
        "files": _dir_stat,
        "file_blob": _file_blob_stat,
    },
    overrides={"day": _stat_day},
)
