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

import fnmatch

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.databricks_volume.glob import resolve_glob
from mirage.core.databricks_volume.readdir import readdir
from mirage.core.databricks_volume.stat import stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, FileType, PathSpec


def _matches_find(
    path: PathSpec,
    file_stat: FileStat,
    name: str | None,
    type_filter: str | None,
) -> bool:
    if type_filter == "file" and file_stat.type == FileType.DIRECTORY:
        return False
    if type_filter == "directory" and file_stat.type != FileType.DIRECTORY:
        return False
    if name is not None and not fnmatch.fnmatch(file_stat.name, name):
        return False
    return bool(path.original)


async def _find_recurse(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    name: str | None,
    type_filter: str | None,
    maxdepth: int | None,
    depth: int,
    index: IndexCacheStore | None,
) -> list[str]:
    results: list[str] = []
    file_stat = await stat(accessor, path, index)
    if depth > 0 and _matches_find(path, file_stat, name, type_filter):
        results.append(path.original)
    if file_stat.type != FileType.DIRECTORY:
        return results
    if maxdepth is not None and depth >= maxdepth:
        return results
    entries = await readdir(accessor, path, index)
    for entry in entries:
        entry_path = PathSpec(
            original=entry,
            directory=entry,
            resolved=False,
            prefix=path.prefix,
        )
        results.extend(await _find_recurse(
            accessor,
            entry_path,
            name,
            type_filter,
            maxdepth,
            depth + 1,
            index,
        ))
    return results


@command("find", resource="databricks_volume", spec=SPECS["find"])
async def find(
    accessor: DatabricksVolumeAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    name: str | None = None,
    type: str | None = None,
    maxdepth: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    paths = await resolve_glob(accessor, paths, index)
    path = paths[0]
    type_filter = None
    if type == "d":
        type_filter = "directory"
    elif type == "f":
        type_filter = "file"
    elif type is not None:
        type_filter = type
    depth = int(maxdepth) if maxdepth is not None else None
    results = await _find_recurse(accessor, path, name, type_filter, depth, 0,
                                  index)
    return "\n".join(results).encode(), IOResult()
