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

from typing import Any

from mirage.cache.file import io as cache_io
from mirage.cache.manager import CacheManager
from mirage.io import IOResult
from mirage.types import ConsistencyPolicy, FileStat, PathSpec
from mirage.workspace.mount import MountEntry, MountRegistry
from mirage.workspace.session import assert_mount_allowed

_DISPATCH_READ_OPS = frozenset({"read", "read_bytes"})
_DISPATCH_WRITE_OPS = frozenset(
    {"write", "write_bytes", "append", "unlink", "create", "truncate"})


class Dispatcher:
    """Route a single VFS op to its mount and keep the file cache + index
    consistent.

    Owns the cache/IO coordination that used to live on Workspace: cache
    lookups for read-caching backends, post-write file-cache eviction,
    and parent index invalidation. Constructed with the registry, cache
    store, and
    consistency policy; holds no other workspace state. Drift checking
    stays on Workspace (it reads/writes snapshot-owned state), which guards
    its own dispatch wrapper before delegating here.
    """

    def __init__(self, registry: MountRegistry, cache,
                 consistency: ConsistencyPolicy) -> None:
        self._registry = registry
        self._cache = cache
        self._consistency = consistency

    async def dispatch(self, op: str, path: PathSpec,
                       **kwargs: Any) -> tuple[Any, IOResult]:
        mount = self._registry.mount_for(path.original)
        assert_mount_allowed(mount.prefix)
        caches_reads = mount.resource.caches_reads

        if caches_reads and op in _DISPATCH_READ_OPS:
            cached = await self._cache.get(path.original)
            if cached is not None:
                if self._consistency == ConsistencyPolicy.ALWAYS:
                    try:
                        remote_stat = await mount.execute_op(
                            "stat", path.original)
                    except FileNotFoundError:
                        await self._cache.remove(path.original)
                        raise
                    if (remote_stat is not None
                            and remote_stat.fingerprint is not None):
                        fresh = await self._cache.is_fresh(
                            path.original, remote_stat.fingerprint)
                        if not fresh:
                            await self._cache.remove(path.original)
                            cached = None
                if cached is not None:
                    return cached, IOResult(reads={path.original: cached})

        result = await mount.execute_op(op, path.original, **kwargs)
        if op in _DISPATCH_WRITE_OPS:
            await self.invalidate_after_write(mount, path.original)
        return result, IOResult()

    async def stat(self, path: str) -> FileStat:
        scope = PathSpec(original=path, directory=path, resolved=True)
        result, _ = await self.dispatch("stat", scope)
        return result

    async def readdir(self, path: str) -> list[str]:
        scope = PathSpec(original=path, directory=path, resolved=False)
        raw, _ = await self.dispatch("readdir", scope)
        return raw

    async def apply_io(self, io: IOResult) -> None:
        await cache_io.apply_io(self._cache, io, self.is_cacheable_path)

    def is_cacheable_path(self, path: str) -> bool:
        try:
            mount = self._registry.mount_for(path)
        except ValueError:
            return False
        return mount.resource.caches_reads

    async def invalidate_after_write_by_path(self, path: str) -> None:
        """Drop file-cache + stale parent index after a write to `path`.

        Single source of truth for post-write invalidation. Called from
        both `Workspace.dispatch()` and `Ops._call(write=True)` so a
        write through any code path sees the same invalidation rules:
        file cache is dropped only for read-caching mounts, and the
        parent directory index is dirtied for any mount that maintains
        an index. No-op for paths that resolve to no known mount.

        Args:
            path (str): absolute mount path that was written.
        """
        try:
            mount = self._registry.mount_for(path)
        except ValueError:
            return
        await self.invalidate_after_write(mount, path)

    async def invalidate_after_write(self, mount: MountEntry,
                                     path: str) -> None:
        manager = mount.cache_manager
        if manager is None:
            manager = CacheManager(self._cache,
                                   getattr(mount.resource, "index", None),
                                   mount.prefix, mount.resource.caches_reads)
        await manager.invalidate_after_write(path)
