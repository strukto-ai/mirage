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
from mirage.core.redis.stat import key_stats
from mirage.errors.fs import readdir_error
from mirage.types import FileStat, PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.utils.path import norm


async def readdir(
    accessor: RedisAccessor, path_spec: PathSpec
) -> list[FileStat]:
    virtual = path_spec.virtual
    prefix = mount_prefix_of(path_spec.virtual, path_spec.vfs_path)
    path = path_spec.directory if path_spec.pattern else path_spec.virtual
    if prefix and path.startswith(prefix):
        rest = path[len(prefix) :]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    store = accessor.store
    p = norm(path)
    if not await store.has_dir(p):
        raise await readdir_error(virtual, p, store.has_file, store.has_dir)
    dir_prefix = p.rstrip("/") + "/"
    seen: set[str] = set()
    all_files = await store.list_files()
    all_dirs = await store.list_dirs()
    for key in all_files + list(all_dirs):
        if key == p:
            continue
        if key.startswith(dir_prefix):
            remainder = key[len(dir_prefix) :]
            child = remainder.split("/")[0]
            if child:
                seen.add(dir_prefix + child)
    file_set = set(all_files)
    return await key_stats(
        store, [(key, key not in file_set) for key in sorted(seen)]
    )


async def tree(
    accessor: RedisAccessor, path: PathSpec
) -> dict[str, FileStat] | None:
    """Every key under a directory from one scan, each as ``stat``
    answers it, fetched in one pipeline; None when ``path`` is no
    directory, or when a key's parent is none (a file another client
    left without its folder), so the walk's readdir and stat report
    what is there.

    Args:
        accessor (RedisAccessor): the mount's store.
        path (PathSpec): the directory.
    """
    store = accessor.store
    p = norm(path.mount_path)
    if not await store.has_dir(p):
        return None
    base = p.rstrip("/") + "/"
    dirs = await store.list_dirs()
    keys = [(key, False) for key in await store.list_files(base)]
    keys += [(key, True) for key in sorted(dirs) if key.startswith(base)]
    keys = [(key, is_dir) for key, is_dir in keys if key != p]
    if any((key.rsplit("/", 1)[0] or "/") not in dirs for key, _ in keys):
        return None
    stats = await key_stats(store, keys)
    return {
        key[len(base) :]: st
        for (key, _is_dir), st in zip(keys, stats, strict=True)
    }
