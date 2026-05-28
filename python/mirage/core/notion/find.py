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

from fnmatch import fnmatch

from mirage.accessor.notion import NotionAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.notion.readdir import readdir
from mirage.core.notion.stat import stat
from mirage.types import FileStat, FileType, PathSpec


async def _collect(
    accessor: NotionAccessor,
    path: PathSpec,
    index: IndexCacheStore | None,
    out: list[tuple[str, FileStat]],
) -> None:
    file_stat = await stat(accessor, path, index)
    out.append((path.original, file_stat))
    if file_stat.type != FileType.DIRECTORY:
        return
    for entry in await readdir(accessor, path, index):
        child = PathSpec(original=entry,
                         directory=entry,
                         resolved=False,
                         prefix=path.prefix)
        await _collect(accessor, child, index, out)


async def find(
    accessor: NotionAccessor,
    path: PathSpec,
    name: str | None = None,
    type: str | None = None,
    min_size: int | None = None,
    max_size: int | None = None,
    maxdepth: int | None = None,
    name_exclude: str | None = None,
    or_names: list[str] | None = None,
    mtime_min: float | None = None,
    mtime_max: float | None = None,
    iname: str | None = None,
    path_pattern: str | None = None,
    mindepth: int | None = None,
    index: IndexCacheStore | None = None,
) -> list[str]:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    base = path.strip_prefix
    base = "/" + base.strip("/") if base.strip("/") else "/"
    base_depth = 0 if base == "/" else base.count("/")
    collected: list[tuple[str, FileStat]] = []
    await _collect(accessor, path, index, collected)
    results: list[str] = []
    for entry_path, file_stat in collected:
        rel = entry_path
        if path.prefix and rel.startswith(path.prefix):
            rel = rel[len(path.prefix):] or "/"
        rel = "/" + rel.strip("/") if rel.strip("/") else "/"
        is_dir = file_stat.type == FileType.DIRECTORY
        if type in ("f", "file") and is_dir:
            continue
        if type in ("d", "directory") and not is_dir:
            continue
        entry_name = rel.rsplit("/", 1)[-1]
        if or_names:
            if not any(fnmatch(entry_name, pat) for pat in or_names):
                continue
        elif name is not None and not fnmatch(entry_name, name):
            continue
        if iname is not None and not fnmatch(entry_name.lower(),
                                             iname.lower()):
            continue
        if path_pattern is not None and not fnmatch(rel, path_pattern):
            continue
        if name_exclude is not None and fnmatch(entry_name, name_exclude):
            continue
        depth = 0 if rel == base else rel.count("/") - base_depth
        if maxdepth is not None and depth > maxdepth:
            continue
        if mindepth is not None and depth < mindepth:
            continue
        if not is_dir and (min_size is not None or max_size is not None):
            size = file_stat.size or 0
            if min_size is not None and size < min_size:
                continue
            if max_size is not None and size > max_size:
                continue
        results.append(rel)
    return sorted(results)
