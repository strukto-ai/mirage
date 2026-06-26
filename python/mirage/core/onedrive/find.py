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

from collections.abc import AsyncIterator

import aiohttp

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.commands.builtin.find_eval import (FindEntry, PredNode, build_tree,
                                               emit_start_path, keep,
                                               start_basename)
from mirage.core.onedrive._client import (graph_list, item_url, new_session,
                                          split_path)
from mirage.core.onedrive.stat import stat
from mirage.types import FileType, PathSpec


async def iter_tree(
    config,
    base: str,
    session: aiohttp.ClientSession | None = None,
) -> AsyncIterator[tuple[str, dict, bool]]:
    url = item_url(config, "/" + base if base else "/", action="/children")
    children = await graph_list(config, url, session=session)
    for child in children:
        cname = child.get("name", "")
        rel = f"{base}/{cname}" if base else cname
        is_dir = "folder" in child
        yield rel, child, is_dir
        if is_dir:
            async for entry in iter_tree(config, rel, session=session):
                yield entry


async def find(
    accessor: OneDriveAccessor,
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
    start_name = start_basename(path)
    _, base = split_path(path)
    results: list[str] = []
    saw_descendant = False
    tree = tree if tree is not None else build_tree(name=name,
                                                    iname=iname,
                                                    path_pattern=path_pattern,
                                                    type=type,
                                                    name_exclude=name_exclude,
                                                    or_names=or_names,
                                                    empty=empty)
    async with new_session(accessor.config) as session:
        async for rel, item, is_dir in iter_tree(accessor.config,
                                                 base,
                                                 session=session):
            relative = rel[len(base):].lstrip("/") if base else rel
            depth = relative.count("/") + 1
            if maxdepth is not None and depth > maxdepth:
                continue
            saw_descendant = True
            entry_name = rel.rsplit("/", 1)[-1]
            full_path = "/" + rel
            size = item.get("size", 0)
            is_empty = (None if not empty else
                        (size == 0 if not is_dir else False))
            entry = FindEntry(key=full_path,
                              name=entry_name,
                              kind="d" if is_dir else "f",
                              depth=depth,
                              is_empty=is_empty)
            if not keep(entry, tree, mindepth):
                continue
            if not is_dir:
                if min_size is not None and size < min_size:
                    continue
                if max_size is not None and size > max_size:
                    continue
            results.append(full_path)
    dir_exists = saw_descendant
    if not dir_exists:
        try:
            dir_exists = (await stat(accessor,
                                     path)).type == FileType.DIRECTORY
        except FileNotFoundError:
            dir_exists = False
    if dir_exists:
        root_key = "/" + base if base else "/"
        emit_start_path(results,
                        root_key,
                        start_name,
                        kind="d",
                        is_empty=False if empty else None,
                        exists=True,
                        tree=tree,
                        maxdepth=maxdepth,
                        mindepth=mindepth)
    return sorted(results)
