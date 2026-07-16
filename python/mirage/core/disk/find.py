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

import asyncio
import os
from datetime import datetime, timezone
from pathlib import Path

from mirage.accessor.disk import DiskAccessor
from mirage.commands.builtin.find_eval import (FindEntry, PredNode, build_tree,
                                               emit_start_path, keep,
                                               start_basename)
from mirage.types import PathSpec


def _resolve(root: Path, path: str) -> Path:
    relative = path.lstrip("/")
    resolved = (root / relative).resolve()
    resolved.relative_to(root)
    return resolved


def _find_sync(
    root: Path,
    path: str,
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
    start_name: str = "",
) -> list[str]:
    p = _resolve(root, path)
    base = "/" + path.strip("/")
    base_depth = 0 if base == "/" else base.count("/")
    results: list[str] = []
    tree = tree if tree is not None else build_tree(name=name,
                                                    iname=iname,
                                                    path_pattern=path_pattern,
                                                    type=type,
                                                    name_exclude=name_exclude,
                                                    or_names=or_names,
                                                    empty=empty)

    if p.is_dir():
        root_empty = (not any(p.iterdir())) if empty else None
        emit_start_path(results,
                        base,
                        start_name,
                        kind="d",
                        is_empty=root_empty,
                        exists=True,
                        tree=tree,
                        maxdepth=maxdepth,
                        mindepth=mindepth,
                        min_size=min_size,
                        max_size=max_size)

    for dirpath, dirnames, filenames in os.walk(p):
        dp = Path(dirpath)
        rel = dp.relative_to(root)
        current = "/" + str(rel) if str(rel) != "." else "/"

        current_depth = current.count("/") - base_depth

        if maxdepth is not None and current_depth > maxdepth:
            dirnames.clear()
            continue

        entries: list[tuple[str, str]] = []
        if type != "f" and type != "file":
            for d in dirnames:
                entry_path = current.rstrip("/") + "/" + d
                entries.append((entry_path, "d"))
        if type != "d" and type != "directory":
            for f in filenames:
                entry_path = current.rstrip("/") + "/" + f
                entries.append((entry_path, "f"))

        for entry_path, kind in entries:
            entry_name = entry_path.rsplit("/", 1)[-1]
            depth = entry_path.count("/") - base_depth
            if maxdepth is not None and depth > maxdepth:
                continue

            full = root / entry_path.lstrip("/")
            is_empty: bool | None = None
            if empty:
                try:
                    is_empty = (full.stat().st_size == 0) if kind == "f" else (
                        not any(full.iterdir()))
                except OSError:
                    is_empty = None
            entry = FindEntry(key=entry_path,
                              name=entry_name,
                              kind=kind,
                              depth=depth,
                              is_empty=is_empty)
            if not keep(entry, tree, mindepth):
                continue

            # Directories count as size 0 for -size (deliberate GNU
            # divergence).
            if min_size is not None or max_size is not None:
                if kind == "f":
                    try:
                        size = full.stat().st_size
                    except OSError:
                        continue
                else:
                    size = 0
                if min_size is not None and size < min_size:
                    continue
                if max_size is not None and size > max_size:
                    continue

            if mtime_min is not None or mtime_max is not None:
                try:
                    st = full.stat()
                    mtime = datetime.fromtimestamp(
                        st.st_mtime, tz=timezone.utc).timestamp()
                except OSError:
                    continue
                if mtime_min is not None and mtime < mtime_min:
                    continue
                if mtime_max is not None and mtime > mtime_max:
                    continue

            results.append(entry_path)

    return sorted(results)


async def find(
    accessor: DiskAccessor,
    path_spec: str | PathSpec,
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
    start_name = start_basename(path_spec)
    path = path_spec.mount_path if isinstance(path_spec,
                                              PathSpec) else path_spec
    return await asyncio.to_thread(
        _find_sync,
        accessor.root,
        path,
        name,
        type,
        min_size,
        max_size,
        maxdepth,
        name_exclude,
        or_names,
        mtime_min,
        mtime_max,
        iname,
        path_pattern,
        mindepth,
        empty,
        tree,
        start_name,
    )
