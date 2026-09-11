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

from mirage.accessor.gmail import GmailAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.core.gmail.readdir import readdir
from mirage.core.gmail.scope import detect_scope
from mirage.core.hierarchy.probe import resolve_entry
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import make_stat
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import content_type_for_path
from mirage.utils.key_prefix import mount_key, mount_prefix_of


def _label_stat(match: ScopeMatch, path: PathSpec,
                entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name,
        type=FileType.DIRECTORY,
        extra={"label_id": entry.id},
    )


def _message_stat(match: ScopeMatch, path: PathSpec,
                  entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name,
        type=FileType.FILE,
        content=ContentType.JSON,
        size=entry.size,
        extra={
            "message_id": entry.id,
            **entry.extra
        },
    )


def _attachment_dir_stat(match: ScopeMatch, path: PathSpec,
                         entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name,
        type=FileType.DIRECTORY,
        extra={"message_id": entry.id},
    )


def _attachment_stat(match: ScopeMatch, path: PathSpec,
                     entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name,
        type=FileType.FILE,
        content=content_type_for_path(entry.vfs_name),
        size=entry.size,
        extra={"attachment_id": entry.id},
    )


async def _stat_day(accessor: GmailAccessor, match: ScopeMatch, path: PathSpec,
                    index: IndexCacheStore) -> FileStat:
    """Stat a day directory, which resolves beyond the listed window.

    The label listing groups a bounded number of recent messages into
    day dirs, but the date query answers for any well-formed day, so a
    day under a label that exists is a directory whether or not the
    recent window lists it. A bogus label is ENOENT.

    Args:
        accessor (GmailAccessor): gmail accessor.
        match (ScopeMatch): a match holding ``label`` and ``day``.
        path (PathSpec): the path to stat.
        index (IndexCacheStore): index cache.
    """
    entry = await resolve_entry(readdir, accessor, path, index)
    if entry is not None:
        return FileStat(name=entry.vfs_name, type=FileType.DIRECTORY)
    label_virtual = path.virtual.rstrip("/").rsplit("/", 1)[0]
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    label_spec = PathSpec(virtual=label_virtual,
                          directory=label_virtual,
                          resource_path=mount_key(label_virtual, prefix))
    if await resolve_entry(readdir, accessor, label_spec, index) is None:
        raise enoent(path.virtual)
    return FileStat(name=match.slots["day"], type=FileType.DIRECTORY)


stat = make_stat(
    detect_scope,
    readdir,
    entry_stats={
        "label": _label_stat,
        "message": _message_stat,
        "attachment_dir": _attachment_dir_stat,
        "attachment": _attachment_stat,
    },
    overrides={"day": _stat_day},
)
