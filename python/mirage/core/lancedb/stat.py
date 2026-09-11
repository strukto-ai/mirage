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

from collections.abc import Awaitable, Callable

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.hierarchy.bind import per_accessor
from mirage.core.hierarchy.readdir import Guard
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import StatHook, make_stat
from mirage.core.lancedb.query import table_exists
from mirage.core.lancedb.read import read
from mirage.core.lancedb.readdir import readdir_for
from mirage.core.lancedb.scope import detect_for, table_of
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import content_type_for_extension


def _name_of(path: PathSpec) -> str:
    stripped = path.virtual.rstrip("/")
    return stripped.rsplit("/", 1)[-1] or "/"


async def _table_guard(accessor: LanceDBAccessor, match: ScopeMatch,
                       virtual: str) -> None:
    if not await table_exists(accessor, table_of(accessor.config, match)):
        raise enoent(virtual)


async def _stat_row(accessor: LanceDBAccessor, match: ScopeMatch,
                    path: PathSpec, index: IndexCacheStore) -> FileStat:
    config = accessor.config
    if not await table_exists(accessor, table_of(config, match)):
        raise enoent(path.virtual)
    if match.kind == "row_blob":
        file_type = content_type_for_extension(config.blob_ext)
    else:
        file_type = ContentType.TEXT
    # The row-dir readdir seeds exact card sizes; blob entries and a cold
    # index fall back to rendering the row, so the size is exact either way.
    lookup = await index.get(path.virtual.rstrip("/"))
    if lookup.entry is not None and lookup.entry.size is not None:
        return FileStat(name=_name_of(path),
                        size=lookup.entry.size,
                        type=FileType.FILE,
                        content=file_type)
    data = await read(accessor, path, index)
    return FileStat(name=_name_of(path),
                    size=len(data),
                    type=FileType.FILE,
                    content=file_type)


GUARDS: dict[str, Guard[LanceDBAccessor]] = {"group": _table_guard}

OVERRIDES: dict[str, StatHook[LanceDBAccessor]] = {
    "row_card": _stat_row,
    "row_blob": _stat_row,
}


def _build(accessor: LanceDBAccessor) -> Callable[..., Awaitable[FileStat]]:
    return make_stat(detect_for(accessor),
                     readdir_for(accessor),
                     guards=GUARDS,
                     overrides=OVERRIDES)


stat_for = per_accessor(_build)


async def stat(
    accessor: LanceDBAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    return await stat_for(accessor)(accessor, path, index)
