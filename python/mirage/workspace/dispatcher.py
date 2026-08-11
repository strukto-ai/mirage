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
from mirage.commands.builtin.utils.limit import apply_op_limit
from mirage.context import mount_allowed
from mirage.io import IOResult
from mirage.observe.record import OpRecord
from mirage.ops.config import NO_FOLLOW_OPS, STAMP_WRITE_OPS
from mirage.ops.namespace_view import (merge_readdir, namespace_listing,
                                       namespace_stat)
from mirage.policy import post_ops_gate, pre_ops_gate
from mirage.types import ConsistencyPolicy, FileStat, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.utils.ranges import slice_window
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
# setattr mutates the mount but keeps its own overlay bookkeeping in
# _setattr_via, so it is a write for policy admission without joining
# the dispatcher's post-write invalidation path.
_POLICY_WRITE_OPS = _DISPATCH_WRITE_OPS | frozenset({"setattr"})


def _window(kwargs: dict[str, Any]) -> tuple[int, int | None]:
    """The byte window a read asked for, whole file when it asked none.

    Args:
        kwargs (dict[str, Any]): the op's keyword arguments.
    """
    offset = kwargs.get("offset")
    size = kwargs.get("size")
    return (offset if isinstance(offset, int) else 0,
            size if isinstance(size, int) else None)


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

    def _namespace_result(self, op: str,
                          virtual: str) -> list[str] | FileStat | None:
        """The namespace's own answer for a path no backend serves.

        Child mounts and symlinks are structure the door owns, so a
        directory that exists only because a mount or link sits below it
        still lists and stats. None for any other op, or when the
        namespace knows nothing at ``virtual``.

        Args:
            op (str): the dispatched op name.
            virtual (str): the virtual path being answered.
        """
        prefixes = [m.prefix for m in self._namespace.registry.mounts()]
        if op == "readdir":
            return namespace_listing(prefixes, self._namespace, virtual)
        if op == "stat":
            return namespace_stat(prefixes, self._namespace, virtual)
        return None

    async def _gated_namespace(self, op: str, path: PathSpec,
                               fallback: "list[str] | FileStat") -> Any:
        """Gate a namespace-served answer exactly like a backend one.

        The answer has no owning prefix (the gates see ""), but
        admission still fires: a policy that bounds readdir or stat by
        path must cover the synthetic answer too.

        Args:
            op (str): the dispatched op name.
            path (PathSpec): the op's path scope.
            fallback (list[str] | FileStat): the namespace's answer.
        """
        policies = self._namespace.registry.policies
        write = op in _POLICY_WRITE_OPS
        await pre_ops_gate(policies, op, path, write, "")
        bound = await post_ops_gate(policies, op, path, write, "", fallback)
        if bound is not None:
            return await apply_op_limit(fallback, bound)
        return fallback

    async def dispatch(self, op: str, path: PathSpec,
                       **kwargs: Any) -> tuple[Any, IOResult]:
        if op not in NO_FOLLOW_OPS:
            followed = self._namespace.follow(path.virtual)
            if followed != path.virtual:
                path = PathSpec.from_str_path(followed)
        try:
            mount = self._namespace.mount_for(path.virtual)
        except ValueError:
            # No mount serves the path, but the namespace may still know
            # a directory there (a deeper mount, a link). No mount means
            # no cache to keep straight. The merged names are
            # session-filtered individually.
            fallback = self._namespace_result(op, path.virtual)
            if fallback is None:
                raise
            return await self._gated_namespace(op, path, fallback), IOResult()
        if not mount_allowed(mount.prefix):
            # The mount is real but ungranted, and the namespace may
            # still owe the session a directory here: a granted mount
            # below it already put this path's name in a listing, so
            # walking down to the grant must answer. The names are
            # session-filtered, so nothing of the mount's own content
            # leaks; a path the structure does not owe falls through to
            # the canonical denial below.
            fallback = self._namespace_result(op, path.virtual)
            if fallback is not None:
                return await self._gated_namespace(op, path,
                                                   fallback), IOResult()
        assert_mount_allowed(mount.prefix)
        # Admission policies fire at the door, before the warm-cache
        # early return below: a cached read must be refused exactly
        # like a cold one, or the cache becomes a policy bypass.
        policies = self._namespace.registry.policies
        write = op in _POLICY_WRITE_OPS
        await pre_ops_gate(policies, op, path, write, mount.prefix)
        caches_reads = mount.resource.caches_reads
        # The file cache is keyed on the path alone, and what a command
        # put there is the rendered read. A raw read asks for a
        # different value under the same key, so it must not be served
        # from that cache; nothing populates it from here, so skipping
        # the probe is the whole fix.
        raw = "filetype" in kwargs and kwargs["filetype"] is None

        if caches_reads and not raw and op in _DISPATCH_READ_OPS:
            cached = await self._cache.get(path.virtual)
            if cached is not None and await self._reconciler.may_serve_cached(
                    mount, path.virtual):
                # The cache holds the whole object, so a ranged read is
                # answered by slicing it, never by handing back the
                # whole file: the window is what the caller asked for
                # instead of the file, and git reads pack indexes this
                # way. slice_window is the same helper the ranged read
                # op falls back to, so warm and cold agree.
                offset, size = _window(kwargs)
                served = slice_window(cached, offset, size)
                bound = await post_ops_gate(policies, op, path, write,
                                            mount.prefix, served)
                if bound is not None:
                    served = await apply_op_limit(served, bound)
                return served, IOResult(reads={path.virtual: served})

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
            result = self._namespace_result(op, path.virtual)
            if result is None:
                await self._reconciler.on_op_missing(op, path.virtual)
                raise
        if op == "readdir":
            result = merge_readdir(
                result, [m.prefix for m in self._namespace.registry.mounts()],
                self._namespace, path.virtual)
        if op == "stat" and isinstance(result, FileStat):
            result = merge_overlay_stat(self._namespace.meta_for(path.virtual),
                                        result)
        if op in _DISPATCH_WRITE_OPS:
            observed = time.time() if op in STAMP_WRITE_OPS else None
            await self.invalidate_after_write(mount, path, observed=observed)
            if op == "rename" and isinstance(kwargs.get("dst"), PathSpec):
                await self.invalidate_after_write(mount, kwargs["dst"])
        bound = await post_ops_gate(policies, op, path, write, mount.prefix,
                                    result)
        if bound is not None:
            result = await apply_op_limit(result, bound)
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
