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
from mirage.core.gsheets.readdir import readdir
from mirage.core.gsheets.scope import detect_scope
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import make_stat
from mirage.types import ContentType, FileStat, FileType, PathSpec


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
            "doc_id": entry.id,
            "doc_name": entry.name,
            **entry.extra,
        },
    )


stat = make_stat(detect_scope, readdir, entry_stats={"file": _file_stat})
