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
from mirage.commands.resolve import COMPOUND_EXTENSIONS
from mirage.observe import OpRecord
from mirage.observe.context import push_mount_prefix
from mirage.ops.config import OpsMount
from mirage.ops.registry import OpsRegistry, RegisteredOp
from mirage.runtime import assert_mount_allowed
from mirage.types import FileStat, MountMode, PathSpec
from mirage.utils.key_prefix import mount_key


class Ops:

    def __init__(self,
                 mounts: list[OpsMount],
                 on_write: Callable[[str], Awaitable[None]] | None = None,
                 observer: Any | None = None,
                 agent_id: str = "default",
                 session_id: str = "default") -> None:
        self._mounts = sorted(mounts,
                              key=lambda m: len(m.prefix),
                              reverse=True)
        self._locks: dict[str, asyncio.Lock] = {}
        self._on_write = on_write
        self._observer = observer
        self._agent_id = agent_id
        self._session_id = session_id
        self._registry = OpsRegistry()
        for m in self._mounts:
            for ro in m.ops:
                self._registry.register(ro)
        self.records: list[OpRecord] = []

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

    def _resolve(
            self, path: str
    ) -> tuple[str, str, Accessor, IndexCacheStore, MountMode]:
        """Returns (resource_type, rel_path, accessor, index, mode).

        Args:
            path (str): Virtual path to resolve.

        Returns:
            tuple: resource_type, rel_path, accessor, index, mode.
        """
        norm = "/" + path.strip("/")
        for m in self._mounts:
            if norm == m.prefix.rstrip("/") or norm.startswith(m.prefix):
                rel_path = "/" + norm[len(m.prefix):]
                return m.resource_type, rel_path, m.accessor, m.index, m.mode
        raise ValueError(f"no mount matches path: {path!r}")

    def _mount_prefix(self, path: str) -> str:
        norm = "/" + path.strip("/")
        for m in self._mounts:
            if norm == m.prefix.rstrip("/") or norm.startswith(m.prefix):
                return m.prefix.rstrip("/")
        return ""

    async def _invalidate(self, path: str) -> None:
        if self._on_write is not None:
            await self._on_write(path)

    async def _call(self,
                    op: str,
                    path: str,
                    *args,
                    write: bool = False,
                    **kwargs):
        start = int(time.monotonic() * 1000)
        resource_type, rel_path, accessor, index, mode = self._resolve(path)
        mount_prefix = self._mount_prefix(path)
        assert_mount_allowed(mount_prefix)
        if write and mode == MountMode.READ:
            raise PermissionError(f"mount at {path!r} is read-only")
        prev_prefix = push_mount_prefix(mount_prefix)
        filetype = self._get_filetype(rel_path)
        scope = PathSpec(
            virtual=path,
            directory=path.rsplit("/", 1)[0] or "/",
            resource_path=mount_key(path, mount_prefix),
        )
        try:
            result = await self._registry.call(op,
                                               resource_type,
                                               accessor,
                                               scope,
                                               *args,
                                               filetype=filetype,
                                               index=index,
                                               **kwargs)
        finally:
            push_mount_prefix(prev_prefix)
        if isinstance(result, (bytes, bytearray)):
            nbytes = len(result)
        else:
            nbytes = next(
                (len(a) for a in args if isinstance(a, (bytes, bytearray))), 0)
        self._record(op, path, resource_type, nbytes, start)
        if write:
            await self._invalidate(path)
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
            return await self._call("read", path, offset, size)
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
        if mode == MountMode.READ:
            raise PermissionError(f"mount at {src!r} is read-only")
        mount_prefix = self._mount_prefix(src)
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
        norm = "/" + path.strip("/")
        for m in self._mounts:
            if m.prefix == "/":
                continue
            if norm == m.prefix.rstrip("/") or norm.startswith(m.prefix):
                return True
        return False
