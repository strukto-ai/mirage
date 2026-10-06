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

from mirage.accessor.gcal import GCalAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.gcal.readdir import (
    bucket_zone,
    calendar_index,
    readdir,
    scoped_bucket,
)
from mirage.core.gcal.scope import detect_scope
from mirage.core.hierarchy.probe import resolve_entry
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import make_stat
from mirage.errors.fs import enoent
from mirage.types import ContentType, FileStat, FileType, PathSpec


def _dir_stat(
    match: ScopeMatch, path: PathSpec, entry: IndexEntry
) -> FileStat:
    return FileStat(name=entry.vfs_name, type=FileType.DIRECTORY)


def _file_stat(
    match: ScopeMatch, path: PathSpec, entry: IndexEntry
) -> FileStat:
    return FileStat(
        name=entry.vfs_name,
        type=FileType.FILE,
        content=ContentType.JSON,
        modified=entry.remote_time,
        size=entry.size,
        extra={"event_id": entry.id, **entry.extra},
    )


async def _stat_bucket(
    accessor: GCalAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
) -> FileStat:
    """Stat a bucket directory, which resolves whether or not it is listed.

    A bucket on the mount's grid under a calendar that exists is a
    directory whether or not it holds an event: the range query over it
    is positive proof of what is there, so an event-free bucket (or one
    outside the default listing window) is an empty directory rather than
    a miss.

    Args:
        accessor (GCalAccessor): the mount's accessor.
        match (ScopeMatch): a match holding ``calendar`` and ``bucket``.
        path (PathSpec): the path to stat.
        index (IndexCacheStore): the mount's index cache.
    """
    calendars = await calendar_index(accessor)
    scoped_bucket(
        accessor,
        match.slots["bucket"],
        bucket_zone(accessor, calendars),
        path.virtual,
    )
    entry = await resolve_entry(readdir, accessor, path, index)
    if entry is not None:
        return FileStat(name=entry.vfs_name, type=FileType.DIRECTORY)
    # Ask the calendar list rather than the index: the index only knows
    # the calendar once the ROOT has been listed, which a stat of a bucket
    # two levels down never triggers.
    if match.slots["calendar"] not in calendars:
        raise enoent(path.virtual)
    return FileStat(name=match.slots["bucket"], type=FileType.DIRECTORY)


stat = make_stat(
    detect_scope,
    readdir,
    entry_stats={
        "calendar": _dir_stat,
        "calendar_json": _file_stat,
        "event": _file_stat,
    },
    overrides={"bucket": _stat_bucket},
)
