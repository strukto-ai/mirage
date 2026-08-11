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
import errno
import time
from typing import Any

from mirage.observe import OpRecord
from mirage.ops.config import NO_FOLLOW_OPS, NamespaceLinks, OpsMount
from mirage.policy import PolicyDenied
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, MountMode, PathSpec
from mirage.utils.path import owner_prefix


class Ops:
    """The typed op facade FUSE and programmatic callers use.

    Every op delegates to the workspace dispatcher, so FUSE and
    ``ws.ops`` walk the same pipeline as a shell command: link follow,
    session grants, admission policies, cache read-through, namespace
    structure, and write invalidation all fire once, at that one door.
    The facade keeps only what is its own: the typed surface, op
    recording (``records``/``network_bytes``), and the mount-table
    helpers.

    ``dispatch`` is required, so there is no workspace-less mode. A
    second pipeline here would be a second door, and it drifted from
    the real one exactly as expected: it served no cache, saw no
    namespace structure, and fired the gates only when a caller
    remembered to hand it policies. TypeScript's ``WorkspaceFS`` takes
    the same stance.
    """

    def __init__(self,
                 mounts: list[OpsMount],
                 dispatch: DispatchFn,
                 observer: Any | None = None,
                 agent_id: str = "default",
                 session_id: str = "default",
                 links: NamespaceLinks | None = None) -> None:
        self._mounts = sorted(mounts,
                              key=lambda m: len(m.prefix),
                              reverse=True)
        self._observer = observer
        self._agent_id = agent_id
        self._session_id = session_id
        self._links = links
        self._dispatch = dispatch
        self.records: list[OpRecord] = []

    @property
    def links(self) -> NamespaceLinks | None:
        """The workspace symlink table, when this facade fronts one.

        FUSE reads it for symlink entries (getattr/readlink/readdir and
        link create/remove); None when the workspace has no link table.
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

    def _owner(self, path: str) -> OpsMount | None:
        """The mount owning ``path`` by longest prefix, or None."""
        owner = owner_prefix((m.prefix for m in self._mounts), path)
        if owner is None:
            return None
        return next(m for m in self._mounts if m.prefix == owner)

    def _mount_prefix(self, path: str) -> str:
        m = self._owner(path)
        return "" if m is None else m.prefix.rstrip("/")

    @staticmethod
    def _payload_bytes(result: Any, kwargs: dict[str, Any]) -> int:
        """The op's byte count for recording: result first, else input.

        Args:
            result (Any): what the op returned.
            kwargs (dict): the op's keyword arguments (write payloads
                travel as ``data``).
        """
        if isinstance(result, (bytes, bytearray)):
            return len(result)
        return next(
            (len(v)
             for v in kwargs.values() if isinstance(v, (bytes, bytearray))), 0)

    async def _call(self, op: str, path: str, **kwargs) -> Any:
        """Run one op through the workspace dispatcher and record it.

        The door owns the whole pipeline (follow, grants, gates, cache,
        structure, invalidation); the facade's own share is the record.
        The path is link-followed here first so the record carries the
        resolved path; the door's second follow of an already-resolved
        path is a no-op.

        Whether the op is a write is the door's call too: it reads that
        off the op name, so there is nothing for a caller here to
        declare.

        Args:
            op (str): the op name.
            path (str): the virtual path.
            **kwargs: op arguments, by the op function's names.
        """
        start = int(time.monotonic() * 1000)
        if self._links is not None and op not in NO_FOLLOW_OPS:
            path = self._links.follow(path)
        owner = self._owner(path)
        try:
            result, io = await self._dispatch(op, PathSpec.from_str_path(path),
                                              **kwargs)
        except PolicyDenied as denied:
            # A post_ops deny suppresses the result, not the effect: the
            # backend already ran, so observation must reflect the op
            # before the deny propagates. The suppressed result is gone,
            # so a read's byte count rides on the exception; a write's is
            # still in its own arguments.
            if denied.completed and owner is not None:
                nbytes = (denied.completed_bytes
                          or self._payload_bytes(None, kwargs))
                source = "ram" if denied.from_cache else owner.resource_type
                self._record(op, path, source, nbytes, start)
            raise
        if owner is not None:
            # The door names the server when it is not the owning mount
            # (a warm cache hit, a synthetic namespace answer): neither
            # moved bytes over the network, and "ram" is what
            # OpRecord.is_cache reads. It reports op_bytes when a
            # post_ops limit truncated the result, since the transfer
            # had already happened by then.
            source = io.op_source or owner.resource_type
            nbytes = (io.op_bytes if io.op_bytes is not None else
                      self._payload_bytes(result, kwargs))
            self._record(op, path, source, nbytes, start)
        return result

    async def read(self,
                   path: str,
                   offset: int = 0,
                   size: int | None = None,
                   raw: bool = False) -> bytes:
        """Read file content.

        ``raw`` asks for the stored bytes, skipping a filetype-scoped
        read op the mount registers for this extension and the file
        cache a command's rendered read may have filled. Read-modify-
        write is what needs it: the merged buffer goes back through
        ``write``, which stores, so reading the rendering would store
        the rendering over the file. TypeScript spells the same thing
        ``readFile(path, {raw: true})``.

        Args:
            path (str): Virtual path.
            offset (int): Byte offset for range reads.
            size (int | None): Number of bytes for range reads.
            raw (bool): Read stored bytes rather than a rendered form.

        Returns:
            bytes: File content.
        """
        kwargs: dict[str, Any] = {"filetype": None} if raw else {}
        if offset or size is not None:
            return await self._call("read",
                                    path,
                                    offset=offset,
                                    size=size,
                                    **kwargs)
        return await self._call("read", path, **kwargs)

    async def write(self, path: str, data: bytes) -> None:
        """Write file content.

        Args:
            path (str): Virtual path.
            data (bytes): Content to write.
        """
        await self._call("write", path, data=data)

    async def append(self, path: str, data: bytes) -> None:
        """Append data to a file.

        Args:
            path (str): Virtual path.
            data (bytes): Content to append.
        """
        await self._call("append", path, data=data)

    async def stat(self, path: str) -> FileStat:
        return await self._call("stat", path)

    async def readdir(self, path: str) -> list[str]:
        return await self._call("readdir", path)

    async def mkdir(self, path: str) -> None:
        await self._call("mkdir", path)

    async def unlink(self, path: str) -> None:
        """Delete file.

        Args:
            path (str): Virtual path.
        """
        await self._call("unlink", path)

    async def rmdir(self, path: str) -> None:
        await self._call("rmdir", path)

    async def rename(self, src: str, dst: str) -> None:
        """Rename file or directory within one mount.

        Both ends must resolve to the same mount: a mount is a
        filesystem boundary, and the facade is where a kernel-facing
        whole-workspace FUSE mount needs the refusal, so `mv` between
        two backends falls back to its copy+unlink path instead of
        corrupting one backend's key space with the other's path.

        Args:
            src (str): Source virtual path.
            dst (str): Destination virtual path.

        Raises:
            OSError: EXDEV when the two ends resolve to different
                mounts.
        """
        if self._mount_prefix(src) != self._mount_prefix(dst):
            raise OSError(errno.EXDEV, "Invalid cross-device link", src, None,
                          dst)
        await self._call("rename", src, dst=PathSpec.from_str_path(dst))

    async def create(self, path: str) -> None:
        await self._call("create", path)

    async def truncate(self, path: str, length: int) -> None:
        """Truncate file to given length.

        Args:
            path (str): Virtual path.
            length (int): Target length in bytes.
        """
        await self._call("truncate", path, length=length)

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
        ops themselves still happens at the door; this gate is only about
        what the interception should leave alone.

        Args:
            path (str): Virtual path.

        Returns:
            bool: True if path is under a mount other than the virtual root.
        """
        return owner_prefix(
            (m.prefix for m in self._mounts if m.prefix != "/"),
            path) is not None
