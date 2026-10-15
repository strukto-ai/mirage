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

from functools import partial

from mirage.accessor.ram import RAMAccessor
from mirage.core.ram.stat import key_stat
from mirage.errors.fs import readdir_error
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.path import norm
from mirage.vfs.ram.store import RAMStore


async def _is_file(store: RAMStore, key: str) -> bool:
    return key in store.files


async def _is_dir(store: RAMStore, key: str) -> bool:
    return key in store.dirs


async def child_keys(accessor: RAMAccessor, path: PathSpec) -> list[str]:
    """The keys of a directory's children, sorted.

    Args:
        accessor (RAMAccessor): the mount's store.
        path (PathSpec): the directory.
    """
    target = path.dir if path.pattern else path
    store = accessor.store
    p = norm(target.vfs_path)
    if p not in store.dirs:
        raise await readdir_error(
            path, p, partial(_is_file, store), partial(_is_dir, store)
        )
    dir_prefix = p.rstrip("/") + "/"
    seen: set[str] = set()
    for key in list(store.files) + list(store.dirs):
        if key == p:
            continue
        if key.startswith(dir_prefix):
            remainder = key[len(dir_prefix) :]
            child = remainder.split("/")[0]
            if child:
                seen.add(dir_prefix + child)
    return sorted(seen)


async def readdir(accessor: RAMAccessor, path: PathSpec) -> list[FileStat]:
    # A key restored without its folder still lists the folder.
    return [
        key_stat(accessor.store, key)
        or FileStat(name=key.rsplit("/", 1)[-1], type=FileType.DIRECTORY)
        for key in await child_keys(accessor, path)
    ]


async def tree(
    accessor: RAMAccessor, path: PathSpec
) -> dict[str, FileStat] | None:
    """Every key under a directory, each as ``stat`` answers it; None
    when ``path`` is no directory, or when a key's parent is none (a
    file restored without its folder), so the walk's readdir and stat
    report what is there.

    Args:
        accessor (RAMAccessor): the mount's store.
        path (PathSpec): the directory.
    """
    store = accessor.store
    p = norm(path.mount_path)
    if p not in store.dirs:
        return None
    base = p.rstrip("/") + "/"
    keys = [
        key
        for key in [*store.files, *store.dirs]
        if key.startswith(base) and key != p
    ]
    if any((key.rsplit("/", 1)[0] or "/") not in store.dirs for key in keys):
        return None
    found: dict[str, FileStat] = {}
    for key in keys:
        entry = key_stat(store, key)
        if entry is not None:
            found[key[len(base) :]] = entry
    return found
