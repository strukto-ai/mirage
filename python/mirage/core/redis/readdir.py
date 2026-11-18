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

import logging
from collections.abc import AsyncIterator

from redis.exceptions import NoPermissionError, ResponseError

from mirage.accessor.redis import RedisAccessor
from mirage.cache.index.scope import command_key
from mirage.core.redis.stat import key_stats
from mirage.errors.fs import readdir_error
from mirage.types import FileStat, PathSpec
from mirage.utils.key_prefix import raw_path_of, sorted_prefix
from mirage.utils.path import norm

logger = logging.getLogger(__name__)


async def _scan_paths(
    accessor: RedisAccessor, base: str
) -> AsyncIterator[tuple[str, bool]]:
    try:
        async for item in accessor.store.scan_paths(base):
            yield item
    except ResponseError as exc:
        message = str(exc).lower()
        if "sscan" not in message or not (
            isinstance(exc, NoPermissionError) or "unknown command" in message
        ):
            raise
        logger.debug("Redis directory scan unavailable: %s", exc)
        for key in await accessor.store.list_dirs():
            if key.startswith(base):
                yield key, True


async def readdir(
    accessor: RedisAccessor, path_spec: PathSpec
) -> list[FileStat]:
    virtual = path_spec.virtual
    path = raw_path_of(path_spec.dir if path_spec.pattern else path_spec)
    store = accessor.store
    p = norm(path)
    if not await store.has_dir(p):
        raise await readdir_error(virtual, p, store.has_file, store.has_dir)
    dir_prefix = p.rstrip("/") + "/"
    seen: dict[str, bool] = {}
    async for key, is_dir in _walk_paths(accessor, dir_prefix):
        remainder = key[len(dir_prefix) :]
        child, slash, _ = remainder.partition("/")
        if child:
            name = dir_prefix + child
            seen[name] = seen.get(name, True) and (bool(slash) or is_dir)
    return await key_stats(store, sorted(seen.items()))


async def _walk_paths(
    accessor: RedisAccessor, base: str
) -> AsyncIterator[tuple[str, bool]]:
    """After a bounded probe declines, share one sorted list of names across
    the command's fallback walk. Fetch stat fields only for requested entries."""
    scope = command_key()
    walk = accessor.walks.get(scope) if scope is not None else None
    if scope is not None and walk is not None and base.startswith(walk[0]):
        root, names = walk
        if names is None:
            names = [
                key + "/" if is_dir else key
                async for key, is_dir in _scan_paths(accessor, root)
            ]
            names.sort()
            accessor.walks[scope] = (root, names)
        for name in sorted_prefix(names, base):
            yield (name[:-1], True) if name.endswith("/") else (name, False)
        return
    async for item in _scan_paths(accessor, base):
        yield item


async def tree(
    accessor: RedisAccessor, path: PathSpec, limit: int | None = None
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
    if limit is None:
        dirs = await store.list_dirs()
        keys = [(key, False) for key in await store.list_files(base)]
        keys += [
            (key, True)
            for key in sorted(dirs)
            if key.startswith(base) and key != p
        ]
    else:
        found: dict[str, bool] = {}
        async for key, is_dir in _walk_paths(accessor, base):
            if key == p:
                continue
            if key not in found and len(found) >= limit:
                scope = command_key()
                if scope is not None:
                    walk = accessor.walks.get(scope)
                    if walk is None or not base.startswith(walk[0]):
                        accessor.walks[scope] = (base, None)
                return None
            found[key] = is_dir
        keys = sorted(found.items())
        dirs = {p, *(key for key, is_dir in keys if is_dir)}
    if any((key.rsplit("/", 1)[0] or "/") not in dirs for key, _ in keys):
        return None
    stats = await key_stats(store, keys)
    return {
        key[len(base) :]: st
        for (key, _is_dir), st in zip(keys, stats, strict=True)
    }
