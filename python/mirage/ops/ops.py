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
import time
from collections.abc import Awaitable, Callable
from typing import Any

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.utils.limit import apply_op_limit
from mirage.commands.resolve import COMPOUND_EXTENSIONS
from mirage.context import (assert_mount_allowed, effective_mount_mode,
                            mount_allowed)
from mirage.observe import OpRecord
from mirage.observe.context import push_mount_prefix
from mirage.ops.config import (NO_FOLLOW_OPS, STAMP_WRITE_OPS, NamespaceLinks,
                               OpsMount)
from mirage.ops.namespace_view import (merge_readdir, namespace_listing,
                                       namespace_stat)
from mirage.ops.registry import OpsRegistry, RegisteredOp
from mirage.ops.types import StatOverlay
from mirage.policy import Policies, post_ops_gate, pre_ops_gate
from mirage.types import FileStat, MountMode, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.utils.path import owner_prefix


class Ops:

    def __init__(self,
                 mounts: list[OpsMount],
                 on_write: Callable[[str, float | None], Awaitable[None]]
                 | None = None,
                 observer: Any | None = None,
                 agent_id: str = "default",
                 session_id: str = "default",
                 links: NamespaceLinks | None = None,
                 stat_overlay: StatOverlay | None = None,
                 policies: Policies | None = None) -> None:
        self._mounts = sorted(mounts,
                              key=lambda m: len(m.prefix),
                              reverse=True)
        self._locks: dict[str, asyncio.Lock] = {}
        self._on_write = on_write
        self._observer = observer
        self._agent_id = agent_id
        self._session_id = session_id
        self._links = links
        self._stat_overlay = stat_overlay
        # Admission policies, shared with the workspace registry. This
        # facade is the door FUSE and programmatic ws.ops come through,
        # so the pre/post op hooks must fire here too, not only on the
        # shell's dispatcher.
        self._policies = policies
        self._registry = OpsRegistry()
        for m in self._mounts:
            for ro in m.ops:
                self._registry.register(ro)
        self.records: list[OpRecord] = []

    @property
    def links(self) -> NamespaceLinks | None:
        """The workspace symlink table, when this facade fronts one.

        FUSE reads it for symlink entries (getattr/readlink/readdir and
        link create/remove); None for standalone Ops without a workspace.
        """
        return self._links

    def mount_prefixes(self) -> list[str]:
        """Return the mount prefixes in resolution order.

        Returns:
            list[str]: mount prefixes, longest first.
        """
        return [m.prefix for m in self._mounts]

    def unsized_mounts(self, root_prefix: str = "") -> list[tuple[str, str]]:
        """Mounts whose files cannot be sized without reading them.

        Args:
            root_prefix (str): when non-empty, only consider the mount
                serving this prefix and anything nested under it, matching
                how a scoped mount narrows the tree.

        Returns:
            list[tuple[str, str]]: (prefix, resource_type) pairs, in mount
            resolution order.
        """
        root = root_prefix.rstrip("/")
        found = []
        for m in self._mounts:
            if root and not (m.prefix.rstrip("/") == root
                             or m.prefix.startswith(root + "/")):
                continue
            if not m.sizes_always_known:
                found.append((m.prefix, m.resource_type))
        return found

    def writable_mounts(self, root_prefix: str = "") -> list[tuple[str, str]]:
        """Mounts that accept writes, in mount resolution order.

        Args:
            root_prefix (str): when non-empty, only consider the mount
                serving this prefix and anything nested under it, matching
                how a scoped mount narrows the tree.

        Returns:
            list[tuple[str, str]]: (prefix, resource_type) pairs.
        """
        root = root_prefix.rstrip("/")
        found = []
        for m in self._mounts:
            if root and not (m.prefix.rstrip("/") == root
                             or m.prefix.startswith(root + "/")):
                continue
            if m.mode is not MountMode.READ:
                found.append((m.prefix, m.resource_type))
        return found

    def register_op(self, fn) -> None:
        if hasattr(fn, "_registered_ops"):
            for ro in fn._registered_ops:
                self._registry.register(ro)
        elif isinstance(fn, RegisteredOp):
            self._registry.register(fn)

    def unmount(self, prefix: str) -> None:
        stripped = prefix.strip("/")
        norm = ("/" + stripped + "/" if stripped else "/")
        self._mounts = [m for m in self._mounts if m.prefix != norm]

    def _record(self, op: str, path: str, source: str, nbytes: int,
                start_ms: int) -> None:
        elapsed = int(time.monotonic() * 1000) - start_ms
        rec = OpRecord(
            op=op,
            path=path,
            source=source.value if hasattr(source, 'value') else str(source),
            bytes=nbytes,
            timestamp=int(time.time() * 1000),
            duration_ms=elapsed,
        )
        self.records.append(rec)
        if self._observer is not None:
            asyncio.ensure_future(
                self._observer.log_op(rec, self._agent_id, self._session_id))

    @staticmethod
    def _get_filetype(path: str) -> str | None:
        basename = path.rsplit("/", 1)[-1]
        for ext in COMPOUND_EXTENSIONS:
            if basename.endswith(ext):
                return ext
        dot = path.rfind(".")
        if dot == -1 or "/" in path[dot:]:
            return None
        return path[dot:]

    def _lock_for(self, path: str) -> asyncio.Lock:
        if path not in self._locks:
            self._locks[path] = asyncio.Lock()
        return self._locks[path]

    def _owner(self, path: str) -> OpsMount | None:
        """The mount owning ``path`` by longest prefix, or None."""
        owner = owner_prefix((m.prefix for m in self._mounts), path)
        if owner is None:
            return None
        return next(m for m in self._mounts if m.prefix == owner)

    def _resolve(
            self, path: str
    ) -> tuple[str, str, Accessor, IndexCacheStore, MountMode]:
        """Returns (resource_type, rel_path, accessor, index, mode).

        Args:
            path (str): Virtual path to resolve.

        Returns:
            tuple: resource_type, rel_path, accessor, index, mode.
        """
        m = self._owner(path)
        if m is None:
            raise ValueError(f"no mount matches path: {path!r}")
        norm = "/" + path.strip("/")
        rel_path = "/" + norm[len(m.prefix):]
        return m.resource_type, rel_path, m.accessor, m.index, m.mode

    def _mount_prefix(self, path: str) -> str:
        m = self._owner(path)
        return "" if m is None else m.prefix.rstrip("/")

    async def _invalidate(self,
                          path: str,
                          observed: float | None = None) -> None:
        if self._on_write is not None:
            await self._on_write(path, observed)

    def _namespace_result(self, op: str,
                          path: str) -> "list[str] | FileStat | None":
        """The namespace's own answer for a path no backend serves.

        Mirrors the workspace dispatcher: a directory that exists only
        because a mount or a link sits below it still lists and stats,
        so FUSE and programmatic callers agree with the shell. None for
        any other op, or when the namespace knows nothing at ``path``.

        Args:
            op (str): the op name.
            path (str): the virtual path being answered.
        """
        if op == "readdir":
            return namespace_listing(self.mount_prefixes(), self._links, path)
        if op == "stat":
            return namespace_stat(self.mount_prefixes(), self._links, path)
        return None

    async def _gated_namespace(self, op: str, path: str, write: bool,
                               fallback: "list[str] | FileStat"):
        """Gate a namespace-served answer exactly like a backend one.

        Mirrors the workspace dispatcher: no owning prefix (the gates
        see ""), but admission still fires so a policy that bounds
        readdir or stat by path covers the synthetic answer too.

        Args:
            op (str): the op name.
            path (str): the virtual path being answered.
            write (bool): whether the op is a write for policy admission.
            fallback (list[str] | FileStat): the namespace's answer.
        """
        if self._policies is None:
            return fallback
        scope = PathSpec(virtual=path,
                         directory=path.rsplit("/", 1)[0] or "/",
                         resource_path="")
        await pre_ops_gate(self._policies, op, scope, write, "")
        bound = await post_ops_gate(self._policies, op, scope, write, "",
                                    fallback)
        if bound is not None:
            return await apply_op_limit(fallback, bound)
        return fallback

    async def _call(self,
                    op: str,
                    path: str,
                    *args,
                    write: bool = False,
                    **kwargs):
        start = int(time.monotonic() * 1000)
        if self._links is not None and op not in NO_FOLLOW_OPS:
            path = self._links.follow(path)
        try:
            resource_type, rel_path, accessor, index, mode = self._resolve(
                path)
        except ValueError:
            fallback = self._namespace_result(op, path)
            if fallback is None:
                raise
            return await self._gated_namespace(op, path, write, fallback)
        mount_prefix = self._mount_prefix(path)
        if not mount_allowed(mount_prefix):
            # The mount is real but ungranted, and the namespace may
            # still owe the session a directory here: a granted mount
            # below it already put this path's name in a listing, so
            # walking down to the grant must answer. The names are
            # session-filtered, so nothing of the mount's own content
            # leaks; a path the structure does not owe falls through to
            # the canonical denial below.
            fallback = self._namespace_result(op, path)
            if fallback is not None:
                return await self._gated_namespace(op, path, write, fallback)
        assert_mount_allowed(mount_prefix)
        if write and effective_mount_mode(mount_prefix,
                                          mode) == MountMode.READ:
            raise PermissionError(f"mount at {path!r} is read-only")
        prev_prefix = push_mount_prefix(mount_prefix)
        filetype = self._get_filetype(rel_path)
        scope = PathSpec(
            virtual=path,
            directory=path.rsplit("/", 1)[0] or "/",
            resource_path=mount_key(path, mount_prefix),
        )
        if self._policies is not None:
            await pre_ops_gate(self._policies, op, scope, write, mount_prefix)
        try:
            result = await self._registry.call(op,
                                               resource_type,
                                               accessor,
                                               scope,
                                               *args,
                                               filetype=filetype,
                                               index=index,
                                               **kwargs)
        except FileNotFoundError:
            result = self._namespace_result(op, path)
            if result is None:
                raise
        finally:
            push_mount_prefix(prev_prefix)
        if op == "readdir":
            result = merge_readdir(result, self.mount_prefixes(), self._links,
                                   path)
        if isinstance(result, (bytes, bytearray)):
            nbytes = len(result)
        else:
            nbytes = next(
                (len(a) for a in args if isinstance(a, (bytes, bytearray))), 0)
        self._record(op, path, resource_type, nbytes, start)
        if write:
            observed = time.time() if op in STAMP_WRITE_OPS else None
            await self._invalidate(path, observed)
        # Bookkeeping precedes the post gate: a denied result is still a
        # completed backend op, so the caches and observation must
        # reflect it before the deny suppresses it.
        if self._policies is not None:
            bound = await post_ops_gate(self._policies, op, scope, write,
                                        mount_prefix, result)
            if bound is not None:
                result = await apply_op_limit(result, bound)
        if (op == "stat" and self._stat_overlay is not None
                and isinstance(result, FileStat)):
            return self._stat_overlay(path, result)
        return result

    async def read(self,
                   path: str,
                   offset: int = 0,
                   size: int | None = None) -> bytes:
        """Read file content.

        Args:
            path (str): Virtual path.
            offset (int): Byte offset for range reads.
            size (int | None): Number of bytes for range reads.

        Returns:
            bytes: File content.
        """
        if offset or size is not None:
            return await self._call("read", path, offset=offset, size=size)
        return await self._call("read", path)

    async def write(self, path: str, data: bytes) -> None:
        """Write file content.

        Args:
            path (str): Virtual path.
            data (bytes): Content to write.
        """
        await self._call("write", path, data, write=True)

    async def append(self, path: str, data: bytes) -> None:
        """Append data to a file.

        Args:
            path (str): Virtual path.
            data (bytes): Content to append.
        """
        await self._call("append", path, data, write=True)

    async def stat(self, path: str) -> FileStat:
        return await self._call("stat", path)

    async def readdir(self, path: str) -> list[str]:
        return await self._call("readdir", path)

    async def mkdir(self, path: str) -> None:
        await self._call("mkdir", path, write=True)

    async def unlink(self, path: str) -> None:
        """Delete file.

        Args:
            path (str): Virtual path.
        """
        await self._call("unlink", path, write=True)

    async def rmdir(self, path: str) -> None:
        await self._call("rmdir", path, write=True)

    async def rename(self, src: str, dst: str) -> None:
        """Rename file or directory.

        Args:
            src (str): Source virtual path.
            dst (str): Destination virtual path.
        """
        start = int(time.monotonic() * 1000)
        resource_type, _, accessor, _, mode = self._resolve(src)
        mount_prefix = self._mount_prefix(src)
        assert_mount_allowed(mount_prefix)
        if effective_mount_mode(mount_prefix, mode) == MountMode.READ:
            raise PermissionError(f"mount at {src!r} is read-only")
        src_scope = PathSpec(
            virtual=src,
            directory=src.rsplit("/", 1)[0] or "/",
            resource_path=mount_key(src, mount_prefix),
        )
        dst_scope = PathSpec(
            virtual=dst,
            directory=dst.rsplit("/", 1)[0] or "/",
            resource_path=mount_key(dst, mount_prefix),
        )
        fn = self._registry.resolve("rename", resource_type)
        await fn(accessor, src_scope, dst_scope)
        await self._invalidate(src)
        await self._invalidate(dst)
        self._record("rename", src, resource_type, 0, start)

    async def create(self, path: str) -> None:
        await self._call("create", path, write=True)

    async def truncate(self, path: str, length: int) -> None:
        """Truncate file to given length.

        Args:
            path (str): Virtual path.
            length (int): Target length in bytes.
        """
        await self._call("truncate", path, length, write=True)

    @property
    def network_records(self) -> list[OpRecord]:
        """Records that hit a remote resource (not cache)."""
        return [r for r in self.records if not r.is_cache]

    @property
    def network_bytes(self) -> int:
        """Total bytes transferred over the network."""
        return sum(r.bytes for r in self.records if not r.is_cache)

    @property
    def cache_records(self) -> list[OpRecord]:
        """Records served from in-memory cache."""
        return [r for r in self.records if r.is_cache]

    @property
    def cache_bytes(self) -> int:
        """Total bytes served from cache."""
        return sum(r.bytes for r in self.records if r.is_cache)

    def is_mounted(self, path: str) -> bool:
        """Check if a path is under an explicit mount.

        Used by the open()/os interception to decide whether a path is a
        workspace path (route through ops) or a real OS path (pass through).
        The catch-all virtual root at ``/`` is skipped on purpose: it matches
        every absolute path, so counting it would hijack real filesystem
        paths (a FUSE mountpoint, ``/tmp``) into ops. Routing to the root for
        ops themselves still happens via ``_resolve``; this gate is only about
        what the interception should leave alone.

        Args:
            path (str): Virtual path.

        Returns:
            bool: True if path is under a mount other than the virtual root.
        """
        return owner_prefix(
            (m.prefix for m in self._mounts if m.prefix != "/"),
            path) is not None
