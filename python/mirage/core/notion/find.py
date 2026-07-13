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

from mirage.accessor.notion import NotionAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.find_eval import (FindEntry, PredNode, build_tree,
                                               keep, start_basename)
from mirage.core.notion.readdir import readdir
from mirage.core.notion.stat import stat
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of


async def _collect(
    accessor: NotionAccessor,
    path: PathSpec,
    index: IndexCacheStore | None,
    out: list[tuple[str, FileStat]],
) -> None:
    file_stat = await stat(accessor, path, index)
    out.append((path.virtual, file_stat))
    if file_stat.type != FileType.DIRECTORY:
        return
    for entry in await readdir(accessor, path, index):
        child = PathSpec(virtual=entry,
                         directory=entry,
                         resolved=False,
                         resource_path=mount_key(
                             entry,
                             mount_prefix_of(path.virtual,
                                             path.resource_path)))
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
    empty: bool = False,
    tree: PredNode | None = None,
    index: IndexCacheStore | None = None,
) -> list[str]:
    start_name = start_basename(path)
    base = path.mount_path
    base = "/" + base.strip("/") if base.strip("/") else "/"
    base_depth = 0 if base == "/" else base.count("/")
    collected: list[tuple[str, FileStat]] = []
    await _collect(accessor, path, index, collected)
    results: list[str] = []
    tree = tree if tree is not None else build_tree(name=name,
                                                    iname=iname,
                                                    path_pattern=path_pattern,
                                                    type=type,
                                                    name_exclude=name_exclude,
                                                    or_names=or_names)
    for entry_path, file_stat in collected:
        rel = entry_path
        if mount_prefix_of(
                path.virtual, path.resource_path) and rel.startswith(
                    mount_prefix_of(path.virtual, path.resource_path)):
            rel = rel[len(mount_prefix_of(path.virtual, path.resource_path)
                          ):] or "/"
        rel = "/" + rel.strip("/") if rel.strip("/") else "/"
        is_dir = file_stat.type == FileType.DIRECTORY
        entry_name = start_name if rel == base else rel.rsplit("/", 1)[-1]
        depth = 0 if rel == base else rel.count("/") - base_depth
        if maxdepth is not None and depth > maxdepth:
            continue
        entry = FindEntry(key=rel,
                          name=entry_name,
                          kind="d" if is_dir else "f",
                          depth=depth)
        if not keep(entry, tree, mindepth):
            continue
        if min_size is not None or max_size is not None:
            # Directories count as size 0 for -size (deliberate GNU
            # divergence).
            size = 0 if is_dir else (file_stat.size or 0)
            if min_size is not None and size < min_size:
                continue
            if max_size is not None and size > max_size:
                continue
        results.append(rel)
    return sorted(results)
