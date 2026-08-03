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

import time
from typing import Any

from mirage.cache.file import io as cache_io
from mirage.cache.manager import CacheManager
from mirage.io import IOResult
from mirage.observe.record import OpRecord
from mirage.ops.config import NO_FOLLOW_OPS, STAMP_WRITE_OPS
from mirage.policy import post_ops_gate, pre_ops_gate
from mirage.types import ConsistencyPolicy, FileStat, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.workspace.mount import MountEntry
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.mount.namespace.overlay import merge_overlay_stat
from mirage.workspace.reconcile import Reconciler
from mirage.workspace.session import assert_mount_allowed

_DISPATCH_READ_OPS = frozenset({"read", "read_bytes"})
_DISPATCH_WRITE_OPS = frozenset({
    "write", "write_bytes", "append", "unlink", "create", "truncate", "mkdir",
    "rmdir", "rename"
})


class Dispatcher:
    """Route a single VFS op to its mount and keep the file cache + index
    consistent.

    Owns the cache/IO coordination that used to live on Workspace: cache
    lookups for read-caching backends, post-write file-cache eviction,
    and parent index invalidation. Constructed with the namespace (for
    addressing), cache store, and consistency policy; holds no other
    workspace state. Drift checking stays on Workspace (it reads/writes
    snapshot-owned state), which guards its own dispatch wrapper before
    delegating here.
    """

    def __init__(self, namespace: Namespace, cache,
                 consistency: ConsistencyPolicy) -> None:
        self._namespace = namespace
        self._cache = cache
        self._reconciler = Reconciler(cache, namespace, consistency)

    @property
    def reconciler(self) -> Reconciler:
        return self._reconciler

    async def dispatch(self, op: str, path: PathSpec,
                       **kwargs: Any) -> tuple[Any, IOResult]:
        if op not in NO_FOLLOW_OPS:
            followed = self._namespace.follow(path.virtual)
            if followed != path.virtual:
                path = PathSpec.from_str_path(followed)
        mount = self._namespace.mount_for(path.virtual)
        assert_mount_allowed(mount.prefix)
        # Admission policies fire at the door, before the warm-cache
        # early return below: a cached read must be refused exactly
        # like a cold one, or the cache becomes a policy bypass.
        policies = self._namespace.registry.policies
        write = op in _DISPATCH_WRITE_OPS
        await pre_ops_gate(policies, op, path, write, mount.prefix)
        caches_reads = mount.resource.caches_reads

        if caches_reads and op in _DISPATCH_READ_OPS:
            cached = await self._cache.get(path.virtual)
            if cached is not None and await self._reconciler.may_serve_cached(
                    mount, path.virtual):
                await post_ops_gate(policies, op, path, write, mount.prefix,
                                    cached)
                return cached, IOResult(reads={path.virtual: cached})

        if op == "rename" and isinstance(kwargs.get("dst"), PathSpec):
            # Ops.rename addresses both endpoints against the source's
            # mount; mirror that here so the backend sees a
            # mount-relative destination.
            dst = kwargs["dst"]
            kwargs["dst"] = PathSpec(
                virtual=dst.virtual,
                directory=dst.virtual.rsplit("/", 1)[0] or "/",
                resource_path=mount_key(dst.virtual, mount.prefix.rstrip("/")),
            )
        try:
            result = await mount.execute_op(op, path.virtual, **kwargs)
        except FileNotFoundError:
            await self._reconciler.on_op_missing(op, path.virtual)
            raise
        if op == "stat" and isinstance(result, FileStat):
            result = merge_overlay_stat(self._namespace.meta_for(path.virtual),
                                        result)
        if op in _DISPATCH_WRITE_OPS:
            observed = time.time() if op in STAMP_WRITE_OPS else None
            await self.invalidate_after_write(mount, path, observed=observed)
            if op == "rename" and isinstance(kwargs.get("dst"), PathSpec):
                await self.invalidate_after_write(mount, kwargs["dst"])
        await post_ops_gate(policies, op, path, write, mount.prefix, result)
        return result, IOResult()

    async def stat(self, path: str) -> FileStat:
        scope = PathSpec(virtual=path,
                         directory=path,
                         resource_path="",
                         resolved=True)
        result, _ = await self.dispatch("stat", scope)
        return result

    async def readdir(self, path: str) -> list[str]:
        scope = PathSpec(virtual=path,
                         directory=path,
                         resource_path="",
                         resolved=False)
        raw, _ = await self.dispatch("readdir", scope)
        return raw

    async def apply_io(self,
                       io: IOResult,
                       records: list[OpRecord] | None = None) -> None:
        await cache_io.apply_io(self._cache,
                                io,
                                self.is_cacheable_path,
                                records=records)

    def is_cacheable_path(self, path: str) -> bool:
        try:
            mount = self._namespace.mount_for(path)
        except ValueError:
            return False
        return mount.resource.caches_reads

    async def invalidate_all_after_remote(self) -> None:
        """Drop the file cache and every mount index wholesale.

        A whole-line runtime may have written anywhere in its view of
        the workspace, so per-path invalidation cannot apply: clear
        the read caches so the next local command refetches from the
        backends instead of serving pre-line state.

        Example: `cat /data/x` caches "old" locally; `python3 job.py`
        runs in the sandbox and writes "new" straight to S3 via its own
        FUSE mount, which the local dispatch never saw; without this
        reset the next `cat /data/x` would serve the stale "old".
        """
        if self._cache is not None:
            await self._cache.clear()
        for mount in self._namespace.registry.mounts():
            await mount.resource.index.clear()

    async def invalidate_after_write_by_path(self,
                                             path: str,
                                             observed: float | None = None
                                             ) -> None:
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
            mount = self._namespace.mount_for(path)
        except ValueError:
            return
        spec = PathSpec.from_str_path(
            path, mount_key(path, mount.prefix.rstrip("/")))
        await self.invalidate_after_write(mount, spec, observed=observed)

    async def invalidate_after_write(self,
                                     mount: MountEntry,
                                     path: PathSpec,
                                     observed: float | None = None) -> None:
        await self._namespace.clear_times(path.virtual, observed=observed)
        manager = mount.cache_manager
        if manager is None:
            manager = CacheManager(self._cache, mount.resource.index,
                                   mount.prefix, mount.resource.caches_reads)
        await manager.invalidate_after_write(path)
