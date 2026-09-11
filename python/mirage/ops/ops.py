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
from typing import Any

from mirage.io import OpReport
from mirage.observe import OpRecord
from mirage.observe.context import OpTimer, finish_record, start_op
from mirage.ops.config import NO_FOLLOW_OPS, NamespaceLinks, OpsMount
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.utils.errors import NoMountError
from mirage.utils.path import owner_prefix


class Ops:
    """The typed op facade FUSE and programmatic callers use.

    Every op delegates to the workspace dispatcher, so FUSE and
    ``ws.fs`` walk the same pipeline as a shell command: link follow,
    session grants, admission policies, cache read-through, namespace
    structure, and write invalidation all fire once, at that one door.
    The facade keeps only what is its own: the typed surface, op
    recording (``records``/``network_bytes``), and the mount-table
    helpers.

    ``dispatch`` is required, so there is no workspace-less mode. A
    second pipeline here would be a second door, and it drifted from
    the real one exactly as expected: it served no cache, saw no
    namespace structure, and fired the gates only when a caller
    remembered to hand it policies. TypeScript's ``Ops`` takes
    the same stance.
    """

    def __init__(self,
                 mounts: list[OpsMount],
                 dispatch: DispatchFn,
                 observer: Any | None = None,
                 agent_id: str = "default",
                 session_id: str = "default",
                 links: NamespaceLinks | None = None) -> None:
        self.set_mounts(mounts)
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

    def set_mounts(self, mounts: list[OpsMount]) -> None:
        """Refresh mount metadata without replacing the facade or its ledger.

        Args:
            mounts (list[OpsMount]): the workspace's current mount table.
        """
        self._mounts = sorted(mounts,
                              key=lambda m: len(m.prefix),
                              reverse=True)

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
                timer: OpTimer) -> None:
        rec = finish_record(
            op,
            path,
            source.value if hasattr(source, 'value') else str(source),
            nbytes,
            timer,
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
        path is a no-op. ``nofollow`` is the caller's
        AT_SYMLINK_NOFOLLOW and suppresses both follows, so an op meant
        for a link entry itself (``chmod -h``, a guest's ``lchown``)
        still records the link's own path.

        Whether the op is a write is the door's call too: it reads that
        off the op name, so there is nothing for a caller here to
        declare.

        Args:
            op (str): the op name.
            path (str): the virtual path.
            **kwargs: op arguments, by the op function's names.
        """
        timer = start_op()
        if (self._links is not None and op not in NO_FOLLOW_OPS
                and not kwargs.get("nofollow")):
            path = self._links.follow(path)
        owner = self._owner(path)
        report = OpReport()
        try:
            result, _ = await self._dispatch(op,
                                             PathSpec.from_str_path(path),
                                             report=report,
                                             **kwargs)
        except BaseException:
            # Anything raised after the op ran (a post_ops deny, a hard
            # output cap, a bookkeeping failure) suppresses the result,
            # not the effect, so observation must reflect the op before
            # the error propagates. The door stamps the report at the
            # moment of completion, so even a foreign error the door
            # never defined leaves the transfer on the books.
            if report.completed and owner is not None:
                self._record_op(op, path, owner, report.source, report.bytes,
                                None, kwargs, timer)
            raise
        if owner is not None:
            self._record_op(op, path, owner, report.source, report.bytes,
                            result, kwargs, timer)
        return result

    def _record_op(self, op: str, path: str, owner: OpsMount,
                   source: str | None, moved: int | None, result: Any,
                   kwargs: dict[str, Any], timer: OpTimer) -> None:
        """Record one op from the door's report of who served it.

        The door names the server when it was not the owning mount (a
        warm cache hit, a synthetic namespace answer): neither moved
        bytes over the network, and "ram" is what ``OpRecord.is_cache``
        reads. It names the moved bytes when the delivered result no
        longer measures them, because a cap truncated it or a refusal
        withheld it entirely.

        Args:
            op (str): the op name.
            path (str): the resolved virtual path.
            owner (OpsMount): the mount owning the path.
            source (str | None): the door's server, None for the mount.
            moved (int | None): bytes the backend moved, None to
                measure the result.
            result (Any): what the op returned, None when withheld.
            kwargs (dict[str, Any]): the op's arguments.
            timer (OpTimer): the stopwatch opened when the op started.
        """
        nbytes = (moved if moved is not None else self._payload_bytes(
            result, kwargs))
        self._record(op, path, source or owner.resource_type, nbytes, timer)

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

    # The three probes below answer "is this path there?", so only a
    # genuine missing path may read back as False: the typed registry
    # miss (NoMountError) and the backend's own absence. An auth
    # failure, a timeout, or a backend bug is not an answer to that
    # question; swallowing it would let a caller act on a false
    # "missing" (overwrite, recreate, skip). Mirrors the TS facade.
    async def exists(self, path: str) -> bool:
        """True when a stat answers for the path.

        Args:
            path (str): Virtual path.
        """
        try:
            await self.stat(path)
        except (FileNotFoundError, NoMountError):
            return False
        return True

    async def is_dir(self, path: str) -> bool:
        """True when the path stats as a directory.

        Args:
            path (str): Virtual path.
        """
        try:
            st = await self.stat(path)
        except (FileNotFoundError, NoMountError):
            return False
        return st.type == FileType.DIRECTORY

    async def is_file(self, path: str) -> bool:
        """True when the path stats as anything but a directory.

        Args:
            path (str): Virtual path.
        """
        try:
            st = await self.stat(path)
        except (FileNotFoundError, NoMountError):
            return False
        return st.type != FileType.DIRECTORY

    async def cat(self, path: str) -> str:
        """The file's content as text (the TS facade's ``cat``).

        Args:
            path (str): Virtual path.
        """
        data = await self.read(path)
        return data.decode("utf-8", errors="replace")

    async def list_files(self, path: str) -> list[str]:
        """Basenames of the directory's files, directories dropped.

        Args:
            path (str): Virtual path.
        """
        files = []
        for entry in await self.readdir(path):
            if await self.is_file(entry):
                files.append(entry.rstrip("/").rsplit("/", 1)[-1])
        return files

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

    async def symlink(self, path: str, target: str) -> None:
        """Create a namespace symlink at ``path``.

        Routed through the door like every write: session grants and
        admission policies fire on the link's turf, and the write lands
        on the ledger. The target is stored verbatim as typed.

        Args:
            path (str): Virtual path of the link.
            target (str): What the link points to, as typed.

        Raises:
            FileExistsError: something is already at ``path`` (a file, a
                directory, another link, a mount root). symlink(2) never
                overwrites, and the door is the layer that can see both
                planes to tell.
        """
        await self._call("symlink", path, target=target)

    async def readlink(self, path: str) -> str:
        """The stored target of the link at ``path``.

        Args:
            path (str): Virtual path of the link.

        Raises:
            OSError: EINVAL when the path is not a link.
        """
        return await self._call("readlink", path)

    async def setattr(self,
                      path: str,
                      *,
                      mode: int | None = None,
                      uid: int | str | None = None,
                      gid: int | str | None = None,
                      atime: str | None = None,
                      mtime: str | None = None,
                      nofollow: bool = False) -> dict[str, int | str]:
        """Write metadata fields, natively where the backend can hold them.

        Every field is passed, unset ones as None, because the door
        reads the whole set and stores in the namespace overlay whatever
        the backend cannot keep. A mount with no setattr op therefore
        still answers: a chmod on an s3 or dropbox mount lands in the
        name plane and stat reports it back. Stored, not enforced; the
        mount mode is the access control.

        Args:
            path (str): Virtual path.
            mode (int | None): permission bits (e.g. 0o644).
            uid (int | str | None): owner id or name.
            gid (int | str | None): group id or name.
            atime (str | None): ISO access time.
            mtime (str | None): ISO modification time.
            nofollow (bool): write the link entry's own attrs rather
                than its target's (the ``-h`` family).

        Returns:
            dict[str, int | str]: the fields the backend could not keep,
                which the door stored in the overlay instead.
        """
        return await self._call("setattr",
                                path,
                                mode=mode,
                                uid=uid,
                                gid=gid,
                                atime=atime,
                                mtime=mtime,
                                nofollow=nofollow)

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
