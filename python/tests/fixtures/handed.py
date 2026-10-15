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

import inspect
from collections.abc import Awaitable, Callable
from typing import Any

from mirage.types import DirListing, FileStat, PathSpec
from mirage.utils.key_prefix import mount_prefix_of

ListFn = Callable[..., Awaitable[list[FileStat] | DirListing]]


async def entry_at(
    readdir: ListFn, accessor: Any, path: PathSpec
) -> FileStat | None:
    """What is at ``path``, found by listing each folder from the mount
    root down, each handed what its parent's listing named, as the mount
    finds it, or by path alone for a backend whose listing takes no row.
    None for the mount root and for a path nothing is at; a listing of a
    file is ENOTDIR, as it is for the mount.

    Args:
        readdir (ListFn): the backend's readdir.
        accessor (Any): the backend's accessor.
        path (PathSpec): the path.
    """
    prefix = mount_prefix_of(path.virtual, path.vfs_path)
    names = [name for name in path.vfs_path.split("/") if name]
    handed = "entry" in inspect.signature(readdir).parameters
    found: FileStat | None = None
    for depth, name in enumerate(names):
        key = "/".join(names[:depth])
        virtual = f"{prefix}/{key}" if key else prefix or "/"
        folder = PathSpec(virtual=virtual, directory=virtual, vfs_path=key)
        try:
            listed = await (
                readdir(accessor, folder, found)
                if handed
                else readdir(accessor, folder)
            )
        except FileNotFoundError:
            return None
        rows = listed.entries if isinstance(listed, DirListing) else listed
        found = next((row for row in rows if row.name == name), None)
        if found is None:
            return None
    return found


def parent_of(path: PathSpec) -> PathSpec:
    """The folder holding ``path``, addressed like it.

    Args:
        path (PathSpec): the path.
    """
    virtual = path.virtual.rstrip("/").rsplit("/", 1)[0] or "/"
    key = path.vfs_path.strip("/")
    return PathSpec(
        virtual=virtual,
        directory=virtual,
        vfs_path=key.rsplit("/", 1)[0] if "/" in key else "",
    )


async def call(
    fn: Callable[..., Awaitable[Any]],
    readdir: ListFn,
    accessor: Any,
    path: PathSpec,
    *args: Any,
    dst: PathSpec | None = None,
    **kwargs: Any,
) -> Any:
    """Call a backend function the way the mount does: handed each stat
    it declares, found by listing.

    Args:
        fn (Callable[..., Awaitable[Any]]): the backend function.
        readdir (ListFn): the backend's readdir.
        accessor (Any): the backend's accessor.
        path (PathSpec): the function's path.
        *args (Any): its positionals after the path (and ``dst``).
        dst (PathSpec | None): a rename's or a copy's destination.
        **kwargs (Any): its other keywords.
    """
    params = inspect.signature(fn).parameters
    found: dict[str, FileStat | None] = {}
    if "entry" in params:
        found["entry"] = await entry_at(readdir, accessor, path)
    if "parent" in params:
        found["parent"] = await entry_at(readdir, accessor, parent_of(path))
    if dst is not None and "dst_entry" in params:
        found["dst_entry"] = await entry_at(readdir, accessor, dst)
    if dst is not None and "dst_parent" in params:
        found["dst_parent"] = await entry_at(readdir, accessor, parent_of(dst))
    head = (path,) if dst is None else (path, dst)
    return await fn(accessor, *head, *args, **kwargs, **found)
