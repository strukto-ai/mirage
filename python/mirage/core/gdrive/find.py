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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.commands.builtin.find_eval import (FindEntry, PredNode, build_tree,
                                               emit_start_path, keep,
                                               start_basename)
from mirage.core.gdrive.resolve import resolve_key
from mirage.core.gdrive.tree import iter_tree
from mirage.types import PathSpec


async def find(
    accessor: GDriveAccessor,
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
) -> list[str]:
    """find over a Drive subtree, mirroring the msgraph find_items.

    -mtime is a deliberate no-op on remote drive backends (accepted and
    ignored), matching onedrive/sharepoint.

    Args:
        accessor (GDriveAccessor): backend accessor.
        path (PathSpec): search root.
        name (str | None): -name pattern.
        type (str | None): -type f/d.
        min_size (int | None): inclusive size lower bound.
        max_size (int | None): inclusive size upper bound.
        maxdepth (int | None): -maxdepth.
        name_exclude (str | None): ! -name pattern.
        or_names (list[str] | None): -name a -o -name b patterns.
        mtime_min (float | None): ignored (no dir mtimes on Drive).
        mtime_max (float | None): ignored (no dir mtimes on Drive).
        iname (str | None): -iname pattern.
        path_pattern (str | None): -path pattern.
        mindepth (int | None): -mindepth.
        empty (bool): -empty.
        tree (PredNode | None): parsed predicate tree.
    """
    base = path.resource_path
    results: list[str] = []
    saw_descendant = False
    tree = tree if tree is not None else build_tree(name=name,
                                                    iname=iname,
                                                    path_pattern=path_pattern,
                                                    type=type,
                                                    name_exclude=name_exclude,
                                                    or_names=or_names,
                                                    empty=empty)
    try:
        walker = iter_tree(accessor, path)
        async for rel, item, is_dir in walker:
            relative = rel[len(base):].lstrip("/") if base else rel
            depth = relative.count("/") + 1
            if maxdepth is not None and depth > maxdepth:
                continue
            saw_descendant = True
            entry_name = rel.rsplit("/", 1)[-1]
            full_path = "/" + rel
            size = int(item.get("size") or 0)
            is_empty = (None if not empty else
                        (size == 0 if not is_dir else False))
            entry = FindEntry(key=full_path,
                              name=entry_name,
                              kind="d" if is_dir else "f",
                              depth=depth,
                              is_empty=is_empty)
            if not keep(entry, tree, mindepth):
                continue
            if min_size is not None or max_size is not None:
                # Directories count as size 0 for -size (deliberate GNU
                # divergence).
                effective = 0 if is_dir else size
                if min_size is not None and effective < min_size:
                    continue
                if max_size is not None and effective > max_size:
                    continue
            results.append(full_path)
    except (FileNotFoundError, NotADirectoryError):
        saw_descendant = False
    exists = saw_descendant or await _dir_exists(accessor, path)
    if exists:
        root_key = "/" + base if base else "/"
        emit_start_path(results,
                        root_key,
                        start_basename(path),
                        kind="d",
                        is_empty=False if empty else None,
                        exists=True,
                        tree=tree,
                        maxdepth=maxdepth,
                        mindepth=mindepth,
                        min_size=min_size,
                        max_size=max_size)
    return sorted(results)


async def _dir_exists(accessor: GDriveAccessor, path: PathSpec) -> bool:
    if not path.resource_path:
        return True
    node = await resolve_key(accessor, path.resource_path)
    return node is not None and node.is_folder
