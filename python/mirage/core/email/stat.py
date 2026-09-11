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
from mirage.core.email.readdir import readdir
from mirage.core.email.scope import detect_scope
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import make_stat
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.filetype import content_type_for_path


def _dir_stat(match: ScopeMatch, path: PathSpec,
              entry: IndexEntry) -> FileStat:
    return FileStat(name=entry.vfs_name, type=FileType.DIRECTORY)


def _message_stat(match: ScopeMatch, path: PathSpec,
                  entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name,
        type=FileType.FILE,
        content=ContentType.JSON,
        size=entry.size,
        extra={"uid": entry.id},
    )


def _attachment_dir_stat(match: ScopeMatch, path: PathSpec,
                         entry: IndexEntry) -> FileStat:
    return FileStat(
        name=entry.vfs_name,
        type=FileType.DIRECTORY,
        extra={"uid": entry.id},
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


stat = make_stat(
    detect_scope,
    readdir,
    entry_stats={
        "folder": _dir_stat,
        "day": _dir_stat,
        "message": _message_stat,
        "attachment_dir": _attachment_dir_stat,
        "attachment": _attachment_stat,
    },
)
