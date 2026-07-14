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

from mirage.accessor.github import GitHubAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.find_eval import (FindEntry, PredNode, build_tree,
                                               emit_start_path, keep,
                                               start_basename)
from mirage.types import PathSpec


async def find(
    accessor: GitHubAccessor,
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
    mindepth: int | None = None,
    path_pattern: str | None = None,
    empty: bool = False,
    tree: PredNode | None = None,
    *,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    base = path.mount_path.strip("/")
    base_depth = 0 if base == "" else base.count("/") + 1
    start_name = start_basename(path)
    results: list[str] = []
    tree = tree if tree is not None else build_tree(name=name,
                                                    iname=iname,
                                                    path_pattern=path_pattern,
                                                    type=type,
                                                    name_exclude=name_exclude,
                                                    or_names=or_names)
    start_kind = "d" if base == "" else None
    start_size = 0
    has_child = False
    for entry_path in sorted(index._entries):
        p = entry_path.lstrip("/")
        if p == base:
            meta = index._entries[entry_path]
            start_kind = "d" if meta.resource_type == "folder" else "f"
            start_size = meta.size or 0
            continue
        if base and not p.startswith(base + "/"):
            continue
        has_child = True
        entry_meta = index._entries[entry_path]
        is_dir = entry_meta.resource_type == "folder"
        full_path = "/" + p
        depth = p.count("/") + 1 - base_depth
        if maxdepth is not None and depth > maxdepth:
            continue
        entry = FindEntry(key=full_path,
                          name=p.rsplit("/", 1)[-1],
                          kind="d" if is_dir else "f",
                          depth=depth)
        if not keep(entry, tree, mindepth):
            continue
        # Directories count as size 0 for -size (deliberate GNU divergence).
        size = 0 if is_dir else (entry_meta.size or 0)
        if min_size is not None and size < min_size:
            continue
        if max_size is not None and size > max_size:
            continue
        results.append(full_path)
    if start_kind is not None or has_child:
        root_kind = start_kind or "d"
        emit_start_path(results,
                        "/" + base if base else "/",
                        start_name,
                        kind=root_kind,
                        is_empty=None,
                        exists=True,
                        tree=tree,
                        maxdepth=maxdepth,
                        mindepth=mindepth,
                        size=start_size if root_kind == "f" else None,
                        min_size=min_size,
                        max_size=max_size)
    return sorted(results)
