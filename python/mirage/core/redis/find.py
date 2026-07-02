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

from mirage.accessor.redis import RedisAccessor
from mirage.commands.builtin.find_eval import (FindEntry, PredNode, build_tree,
                                               compute_nonempty_dirs,
                                               emit_start_path, keep,
                                               start_basename)
from mirage.types import PathSpec
from mirage.utils.path import norm


async def find(
    accessor: RedisAccessor,
    path: PathSpec,
    name: str | None = None,
    type: str | None = None,
    min_size: int | None = None,
    max_size: int | None = None,
    maxdepth: int | None = None,
    name_exclude: str | None = None,
    or_names: list[str] | None = None,
    iname: str | None = None,
    path_pattern: str | None = None,
    mindepth: int | None = None,
    empty: bool = False,
    tree: PredNode | None = None,
) -> list[str]:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    start_name = start_basename(path)
    if isinstance(path, PathSpec):
        path = path.mount_path
    store = accessor.store
    p = norm(path)
    prefix = p.rstrip("/") + "/"
    base_depth = p.count("/")
    results: list[str] = []
    tree = tree if tree is not None else build_tree(name=name,
                                                    iname=iname,
                                                    path_pattern=path_pattern,
                                                    type=type,
                                                    name_exclude=name_exclude,
                                                    or_names=or_names,
                                                    empty=empty)
    all_files = await store.list_files()
    all_dirs = await store.list_dirs()
    nonempty = compute_nonempty_dirs(
        [*all_files, *(k for k in all_dirs if k != "/")]) if empty else set()

    candidates: list[tuple[str, str]] = []
    if type != "d":
        for key in all_files:
            candidates.append((key, "f"))
    if type != "f":
        for key in all_dirs:
            candidates.append((key, "d"))

    root_kind: str | None = None
    root_is_empty: bool | None = None
    root_size: int | None = None
    for key, kind in candidates:
        if key != p and not key.startswith(prefix):
            continue

        if key == p:
            root_kind = kind
            if empty:
                root_is_empty = (await store.file_len(key)
                                 == 0) if kind == "f" else key not in nonempty
            if kind == "f":
                root_size = await store.file_len(key)
            continue

        if p == "/":
            depth = key.strip("/").count("/") + 1
        else:
            depth = key.count("/") - base_depth

        if maxdepth is not None and depth > maxdepth:
            continue

        is_empty: bool | None = None
        if empty:
            is_empty = (await store.file_len(key)
                        == 0) if kind == "f" else key not in nonempty
        entry = FindEntry(key=key,
                          name=key.rsplit("/", 1)[-1],
                          kind=kind,
                          depth=depth,
                          is_empty=is_empty)
        if not keep(entry, tree, mindepth):
            continue

        if kind == "f" and (min_size is not None or max_size is not None):
            size = await store.file_len(key)
            if min_size is not None and size < min_size:
                continue
            if max_size is not None and size > max_size:
                continue

        results.append(key)

    if root_kind is not None:
        emit_start_path(results,
                        p,
                        start_name,
                        kind=root_kind,
                        is_empty=root_is_empty,
                        exists=True,
                        tree=tree,
                        maxdepth=maxdepth,
                        mindepth=mindepth,
                        size=root_size,
                        min_size=min_size,
                        max_size=max_size)

    return sorted(results)
