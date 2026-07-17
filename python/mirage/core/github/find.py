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
                                               start_basename, tree_has_empty)
from mirage.types import PathSpec
from mirage.utils.dates import matches_mtime


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
                                                    or_names=or_names,
                                                    empty=empty)
    start_kind = "d" if base == "" else None
    start_size = 0
    start_remote_time = ""
    has_child = False
    entries = await index.entries()
    non_empty_dirs: set[str] = set()
    if tree_has_empty(tree):
        # Every intermediate folder is itself an entry, so marking direct
        # parents is enough to classify all non-empty directories.
        non_empty_dirs = {
            entry_path.rsplit("/", 1)[0] or "/"
            for entry_path in entries
        }
    for entry_path in sorted(entries):
        p = entry_path.lstrip("/")
        if p == base:
            meta = entries[entry_path]
            start_kind = "d" if meta.resource_type == "folder" else "f"
            start_size = meta.size or 0
            start_remote_time = meta.remote_time
            continue
        if base and not p.startswith(base + "/"):
            continue
        has_child = True
        entry_meta = entries[entry_path]
        is_dir = entry_meta.resource_type == "folder"
        full_path = "/" + p
        depth = p.count("/") + 1 - base_depth
        if maxdepth is not None and depth > maxdepth:
            continue
        # Directories count as size 0 for -size (deliberate GNU divergence).
        size = 0 if is_dir else (entry_meta.size or 0)
        is_empty = None
        if tree_has_empty(tree):
            is_empty = (entry_path.rstrip("/") not in non_empty_dirs
                        if is_dir else size == 0)
        entry = FindEntry(key=full_path,
                          name=p.rsplit("/", 1)[-1],
                          kind="d" if is_dir else "f",
                          depth=depth,
                          is_empty=is_empty)
        if not keep(entry, tree, mindepth):
            continue
        if min_size is not None and size < min_size:
            continue
        if max_size is not None and size > max_size:
            continue
        if not matches_mtime(entry_meta.remote_time, mtime_min, mtime_max):
            continue
        results.append(full_path)
    if ((start_kind is not None or has_child)
            and matches_mtime(start_remote_time, mtime_min, mtime_max)):
        root_kind = start_kind or "d"
        emit_start_path(
            results,
            "/" + base if base else "/",
            start_name,
            kind=root_kind,
            is_empty=(not has_child if root_kind == "d" else start_size == 0),
            exists=True,
            tree=tree,
            maxdepth=maxdepth,
            mindepth=mindepth,
            size=start_size if root_kind == "f" else None,
            min_size=min_size,
            max_size=max_size)
    return sorted(results)
