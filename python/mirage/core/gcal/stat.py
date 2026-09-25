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
from mirage.core.gcal.readdir import calendar_index, readdir
from mirage.core.gcal.scope import detect_scope
from mirage.core.hierarchy.probe import resolve_entry
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import make_stat
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.errors import enoent


def _dir_stat(match: ScopeMatch, path: PathSpec,
              entry: IndexEntry) -> FileStat:
    return FileStat(name=entry.vfs_name, type=FileType.DIRECTORY)


def _file_stat(match: ScopeMatch, path: PathSpec,
               entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name,
        type=FileType.FILE,
        content=ContentType.JSON,
        modified=entry.remote_time,
        size=entry.size,
        id=entry.id,
        extra={
            "event_id": entry.id,
            **entry.extra
        },
    )


async def _stat_day(accessor: GCalAccessor, match: ScopeMatch, path: PathSpec,
                    index: IndexCacheStore) -> FileStat:
    """Stat a day directory, which resolves whether or not it is listed.

    A well-formed day under a calendar that exists is a directory whether
    or not it holds an event: the range query over that day is positive
    proof of what is there, so an event-free day (or one outside the
    default listing window) is an empty directory rather than a miss.

    Args:
        accessor (GCalAccessor): the mount's accessor.
        match (ScopeMatch): a match holding ``calendar`` and ``day``.
        path (PathSpec): the path to stat.
        index (IndexCacheStore): the mount's index cache.
    """
    entry = await resolve_entry(readdir, accessor, path, index)
    if entry is not None:
        return FileStat(name=entry.vfs_name, type=FileType.DIRECTORY)
    # Ask the calendar list rather than the index: the index only knows
    # the calendar once the ROOT has been listed, which a stat of a day
    # two levels down never triggers.
    if match.slots["calendar"] not in await calendar_index(accessor):
        raise enoent(path.virtual)
    return FileStat(name=match.slots["day"], type=FileType.DIRECTORY)


stat = make_stat(
    detect_scope,
    readdir,
    entry_stats={
        "calendar": _dir_stat,
        "calendar_json": _file_stat,
        "event": _file_stat,
    },
    overrides={"day": _stat_day},
)
