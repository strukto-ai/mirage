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

from mirage.cache.index import IndexEntry
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import make_stat
from mirage.core.notion.readdir import readdir
from mirage.core.notion.scope import detect_scope
from mirage.types import ContentType, FileStat, FileType, PathSpec


def _page_stat(match: ScopeMatch, path: PathSpec,
               entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name,
        type=FileType.DIRECTORY,
        modified=entry.remote_time or None,
        id=entry.id,
        extra={"page_id": entry.id},
    )


def _page_json_stat(match: ScopeMatch, path: PathSpec,
                    entry: IndexEntry) -> FileStat:
    return FileStat(name=entry.vfs_name,
                    type=FileType.FILE,
                    content=ContentType.JSON,
                    size=entry.size)


def _database_stat(match: ScopeMatch, path: PathSpec,
                   entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name,
        type=FileType.DIRECTORY,
        modified=entry.remote_time or None,
        id=entry.id,
        extra={"database_id": entry.id},
    )


def _database_json_stat(match: ScopeMatch, path: PathSpec,
                        entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name,
        type=FileType.FILE,
        content=ContentType.JSON,
        size=entry.size,
        id=match.slots["database_id"],
        extra={"database_id": match.slots["database_id"]},
    )


def _data_source_stat(match: ScopeMatch, path: PathSpec,
                      entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name,
        type=FileType.DIRECTORY,
        modified=entry.remote_time or None,
        id=entry.id,
        extra={"data_source_id": entry.id},
    )


def _data_source_json_stat(match: ScopeMatch, path: PathSpec,
                           entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name,
        type=FileType.FILE,
        content=ContentType.JSON,
        size=entry.size,
        id=match.slots["data_source_id"],
        extra={"data_source_id": match.slots["data_source_id"]},
    )


stat = make_stat(
    detect_scope,
    readdir,
    entry_stats={
        "page": _page_stat,
        "page_json": _page_json_stat,
        "database": _database_stat,
        "database_json": _database_json_stat,
        "data_source": _data_source_stat,
        "data_source_json": _data_source_json_stat,
    },
)
