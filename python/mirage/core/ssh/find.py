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

import asyncssh

from mirage.accessor.ssh import SSHAccessor
from mirage.commands.builtin.find_eval import (FindEntry, PredNode, build_tree,
                                               emit_start_path, keep,
                                               start_basename)
from mirage.core.ssh._client import _abs
from mirage.types import PathSpec


async def find(
    accessor: SSHAccessor,
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
    mindepth: int | None = None,
    path_pattern: str | None = None,
    empty: bool = False,
    tree: PredNode | None = None,
) -> list[str]:
    start_name = start_basename(path_spec)
    path = path_spec.mount_path if isinstance(path_spec,
                                              PathSpec) else path_spec
    config = accessor.config
    sftp = await accessor.sftp()
    results: list[str] = []
    tree = tree if tree is not None else build_tree(name=name,
                                                    iname=iname,
                                                    path_pattern=path_pattern,
                                                    type=type,
                                                    name_exclude=name_exclude,
                                                    or_names=or_names)
    if maxdepth is None or maxdepth >= 0:
        try:
            root_attrs = await sftp.stat(_abs(config, path))
        except (asyncssh.SFTPError, OSError):
            root_attrs = None
        if root_attrs is not None:
            is_dir = root_attrs.type == asyncssh.FILEXFER_TYPE_DIRECTORY
            emit_start_path(results,
                            path,
                            start_name,
                            kind="d" if is_dir else "f",
                            is_empty=False if is_dir else
                            (root_attrs.size or 0) == 0,
                            exists=True,
                            tree=tree,
                            maxdepth=maxdepth,
                            mindepth=mindepth,
                            size=None if is_dir else (root_attrs.size or 0),
                            min_size=min_size,
                            max_size=max_size)
    await _walk(sftp, config, path, results, 0, maxdepth, mindepth, tree,
                min_size, max_size, mtime_min, mtime_max)
    return sorted(results)


async def _walk(sftp, config, path, results, depth, maxdepth, mindepth, tree,
                min_size, max_size, mtime_min, mtime_max):
    if maxdepth is not None and depth > maxdepth:
        return
    remote = _abs(config, path)
    try:
        entries = await sftp.readdir(remote)
    except asyncssh.SFTPNoSuchFile:
        return
    for entry in entries:
        if entry.filename in (".", ".."):
            continue
        child = f"{path.rstrip('/')}/{entry.filename}"
        is_dir = entry.attrs.type == asyncssh.FILEXFER_TYPE_DIRECTORY
        if _matches(entry, child, is_dir, depth + 1, maxdepth, mindepth, tree,
                    min_size, max_size, mtime_min, mtime_max):
            results.append(child)
        if is_dir:
            await _walk(sftp, config, child, results, depth + 1, maxdepth,
                        mindepth, tree, min_size, max_size, mtime_min,
                        mtime_max)


def _matches(entry, path, is_dir, depth, maxdepth, mindepth, tree, min_size,
             max_size, mtime_min, mtime_max):
    if maxdepth is not None and depth > maxdepth:
        return False
    find_entry = FindEntry(key=path,
                           name=path.rsplit("/", 1)[-1],
                           kind="d" if is_dir else "f",
                           depth=depth,
                           is_empty=False if is_dir else
                           (entry.attrs.size or 0) == 0)
    if not keep(find_entry, tree, mindepth):
        return False
    if min_size is not None or max_size is not None:
        # Directories count as size 0 for -size (deliberate GNU divergence).
        size = 0 if is_dir else (entry.attrs.size or 0)
        if min_size is not None and size < min_size:
            return False
        if max_size is not None and size > max_size:
            return False
    if mtime_min is not None or mtime_max is not None:
        mtime = entry.attrs.mtime
        if mtime is not None:
            if mtime_min is not None and mtime < mtime_min:
                return False
            if mtime_max is not None and mtime > mtime_max:
                return False
    return True
