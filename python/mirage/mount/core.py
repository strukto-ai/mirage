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

import errno
import inspect
import os
import posixpath
import time
from dataclasses import asdict, dataclass, field
from typing import Any, cast

from mirage.context import reset_current_session, set_current_session
from mirage.mount.errors import NO_XATTR
from mirage.mount.platform.macos import is_macos_metadata
from mirage.mount.prefetch import PrefetchCache
from mirage.mount.stat import apply_stat_attrs, dir_stat, file_stat, link_stat
from mirage.mount.types import MountAttrs, MountEntry
from mirage.ops import Ops
from mirage.runtime.handles import FileTable, merge_writes
from mirage.types import FileType
from mirage.workspace.session.session import Session

WriteBuf = list[tuple[int, bytes]]


@dataclass(slots=True)
class Handle:
    path: str
    data: bytes | None = None
    write_buf: WriteBuf = field(default_factory=list)


class _ScopedOps:
    """An op facade whose every call runs under one session's grants.

    One wrapper rather than a binding at each of the core's twenty-odd
    op call sites: a core that bound nineteen of them would serve the
    twentieth with the workspace's full reach, and nothing at the
    missing call site would look wrong. The adapters bind at their own
    entry points too, which is harmless -- setting the same contextvar
    twice changes nothing -- and this is what makes the guarantee hold
    for a core constructed directly, with no adapter above it.

    Args:
        inner (Ops): the facade to scope.
        session (Session): the session whose mount grants apply.
    """

    __slots__ = ("_inner", "_session")

    def __init__(self, inner: Ops, session: Session) -> None:
        self._inner = inner
        self._session = session

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._inner, name)
        if not inspect.iscoroutinefunction(attr):
            return attr

        async def scoped(*args: Any, **kwargs: Any) -> Any:
            token = set_current_session(self._session)
            try:
                return await attr(*args, **kwargs)
            finally:
                reset_current_session(token)

        return scoped


class MountCore:
    """Protocol-neutral mount logic shared by every kernel adapter.

    Async-native: every method that reaches the op facade awaits it. An
    adapter whose kernel interface is synchronous -- libfuse's callbacks
    are -- owns the bridge and the loop it runs on, because that is the
    adapter's constraint rather than this layer's. One whose interface is
    already async, like the nfs delegate, simply awaits.

    Everything here is expressed in POSIX terms (``MountAttrs`` rows,
    ordinary Python exceptions) and imports nothing from mfusepy, so it is
    reusable by a non-FUSE adapter (FSKit, File Provider) and unit-testable
    without a kernel or the ``[fuse]`` extra installed.

    The division of labour: this class decides *what* the filesystem
    contains, an adapter decides *how* to say it to a particular kernel
    interface. Adapters translate the exceptions raised here into their own
    error codes with ``mirage.mount.errors.classify_error``.

    Args:
        ops (Ops): the workspace op facade every filesystem call routes to.
        root_prefix (str): mount root; non-empty scopes the tree to one mount.
        session (Session | None): bind every op to this session's mount
            grants, exactly as a shell command in that session would run.
            None means unrestricted.
    """

    def __init__(self,
                 ops: Ops,
                 root_prefix: str = "",
                 session: Session | None = None) -> None:
        self._session = session
        # Scoped here, not at each call site: see _ScopedOps.
        # Cast because the proxy answers the facade by delegation
        # rather than by inheritance: it forwards every attribute and
        # subclassing Ops would mean re-declaring a surface it does not
        # own. Every caller below sees an Ops and nothing else.
        self._ops: Ops = (ops if session is None else cast(
            "Ops", _ScopedOps(ops, session)))
        # Seconds, matching MountAttrs and the TypeScript twin's Date.
        self._now = time.time()
        self._root = root_prefix.rstrip("/")
        self._handles: FileTable[Handle] = FileTable()
        self._prefetch = PrefetchCache()
        # In-memory extended attributes, keyed by path. Backends have no
        # POSIX xattrs, so these are advisory, not persisted (see setxattr).
        self._xattrs: dict[str, dict[str, bytes]] = {}
        # Windows has no getuid/getgid; the values are irrelevant there
        # because the mount passes uid=-1,gid=-1 and WinFsp presents files
        # as owned by the mounting user (see mount.py). Mirrors fs.ts.
        self._uid = os.getuid() if hasattr(os, "getuid") else 0
        self._gid = os.getgid() if hasattr(os, "getgid") else 0

    @property
    def ops(self) -> Ops:
        return self._ops

    @property
    def session(self) -> "Session | None":
        """The session every op runs under, or None for an unscoped mount.

        Read by the adapter, not used here: binding has to happen where
        the call is made, and for a synchronous adapter that means inside
        the coroutine it schedules. TypeScript's core carries it the same
        way, for the same reason.
        """
        return self._session

    @property
    def handles(self) -> FileTable[Handle]:
        return self._handles

    def _ctx(self, fh: int | None) -> Handle | None:
        """The open handle under `fh`, or None for a path-based op.

        Args:
            fh (int | None): handle id; the adapter passes None when the
                kernel op arrived without one.
        """
        return self._handles.get(fh) if fh is not None else None

    def resolve(self, path: str) -> str:
        """Map a mount path onto the workspace, honoring the mount root.

        Args:
            path (str): path as seen inside the mountpoint.

        Returns:
            str: the corresponding workspace path.
        """
        if not self._root:
            return path
        if path == "/":
            return self._root
        return self._root + path

    def dir_stat(self) -> MountAttrs:
        """This mount's base directory row.

        Args:
            None

        Returns:
            MountAttrs: the row, before any namespace overlay.
        """
        return dir_stat(self._uid, self._gid, self._now)

    def file_stat(self, size: int) -> MountAttrs:
        """This mount's base row for a regular file.

        Args:
            size (int): byte length the client should see.

        Returns:
            MountAttrs: the row, before any namespace overlay.
        """
        return file_stat(size, self._uid, self._gid, self._now)

    def link_target(self, path: str) -> str | None:
        """The target to present for a namespace link at a mount path.

        Relative targets are stored verbatim and returned as-is. Absolute
        targets name virtual paths, so they are rewritten relative to the
        link's directory: returned raw, the kernel would resolve them
        against the host root and escape the mountpoint.

        Args:
            path (str): mount path to inspect.

        Returns:
            str | None: displayable target, or None when not a link.
        """
        links = self._ops.links
        if links is None:
            return None
        target = links.readlink(self.resolve(path))
        if target is None:
            return None
        if not target.startswith("/"):
            return target
        virtual_target = target
        if self._root:
            if target == self._root:
                virtual_target = "/"
            elif target.startswith(self._root + "/"):
                virtual_target = target[len(self._root):]
            else:
                # points outside the scoped root: unreachable through this
                # mount, keep the stored form (a dangling link is legal)
                return target
        parent = path.rsplit("/", 1)[0] or "/"
        return posixpath.relpath(virtual_target, parent)

    def link_stat(self, target: str, virtual: str) -> MountAttrs:
        """The row a namespace link reports at a mount path.

        Args:
            target (str): the target as this mount presents it.
            virtual (str): the link's virtual path, for the node row.

        Returns:
            MountAttrs: the link's own row, overlay applied.
        """
        links = self._ops.links
        row = None if links is None else links.link_stat_at(virtual)
        return link_stat(target, row, self._uid, self._gid, self._now)

    def drain_ops(self) -> list[dict[str, Any]]:
        records = [asdict(r) for r in self._ops.records]
        self._ops.records.clear()
        return records

    def cached_data(self, path: str) -> bytes | None:
        """Return prefetched bytes from open handles or the TTL cache.

        Args:
            path (str): mount path to look up.

        Returns:
            bytes | None: cached content, or None when nothing fresh is held.
        """
        for ctx in self._handles.values():
            if ctx.path == path and ctx.data is not None:
                return ctx.data
        return self._prefetch.get(path)

    def cached_size(self, path: str) -> int | None:
        """Return the real size of prefetched data, if any is cached.

        Args:
            path (str): mount path to look up.

        Returns:
            int | None: byte length of cached content, or None.
        """
        data = self.cached_data(path)
        return len(data) if data is not None else None

    async def prefetch_read(self, path: str) -> bytes | None:
        """Fetch and cache the bytes of a size-unknown file.

        Args:
            path (str): mount path being opened.

        Returns:
            bytes | None: file content, or None when the backend read fails
            (open() stays permissive; the subsequent read() surfaces the
            error to the caller).
        """
        cached = self.cached_data(path)
        if cached is not None:
            return cached
        try:
            data = await self._ops.read(self.resolve(path))
        except (FileNotFoundError, ValueError):
            return None
        # No inflight dedup: FUSE mounts run nothreads=True, so callbacks are
        # serialized and two opens cannot race (TS needs the dedup map).
        self._prefetch.put(path, data)
        return data

    async def attrs_for(self, path: str, fh: int | None = None) -> MountAttrs:
        """POSIX attributes for a path, optionally through an open handle.

        Args:
            path (str): mount path to stat.
            fh (int | None): open handle, when the caller is fstat-ing.

        Returns:
            MountAttrs: the entry's POSIX attributes.

        Raises:
            FileNotFoundError: no such entry.
        """
        # fstat(fd) after open: answer with the hydrated handle's real byte
        # length. attr_timeout=0 on FUSE mounts makes the kernel actually ask
        # here instead of trusting the cached pre-open size, which is what
        # keeps wc -c, BSD cp, and tail -c correct for size-unknown files.
        if fh is not None:
            ctx = self._handles.get(fh)
            if ctx is not None and ctx.path == path and ctx.data is not None:
                return self.file_stat(len(ctx.data))
        if path == "/":
            return self.dir_stat()
        # Link check must precede the ops stat: the ops facade follows
        # namespace links, so stat on a link path reports the target.
        target = self.link_target(path)
        if target is not None:
            return self.link_stat(target, self.resolve(path))
        s = await self._ops.stat(self.resolve(path))
        if s.type == FileType.DIRECTORY:
            return apply_stat_attrs(self.dir_stat(), s)
        size = s.size
        if size is None:
            size = self.cached_size(path)
        if size is None:
            # Unopened size-unknown files stat as 0, matching mirage's own
            # find semantics. Reads stay correct anyway: direct_io makes the
            # kernel ignore st_size, and the fh branch above serves the real
            # size to fstat-based tools after open. Never report a fake size
            # and never fetch content here: getattr runs once per entry on
            # every ls -l.
            size = 0
        return apply_stat_attrs(self.file_stat(size), s)

    async def getattr(self, path: str, fh: int | None = None) -> MountAttrs:
        """Attributes for a path a caller reached by name.

        macOS Finder and Spotlight probe .DS_Store, ._*, .Spotlight-V100
        and friends on every listing; refusing here keeps the probe off
        the backend entirely.

        Split from ``attrs_for`` because refusing a name and describing
        an entry are different questions, and only one protocol fuses
        them: libfuse has no LOOKUP, so its getattr is the lookup, while
        NFSv3 addresses an entry by a handle it already minted. Applying
        a name policy there makes a file the client just created vanish.

        Args:
            path (str): mount path to stat.
            fh (int | None): open handle, when the caller is fstat-ing.

        Returns:
            MountAttrs: the entry's POSIX attributes.
        """
        name = path.rsplit("/", 1)[-1]
        if is_macos_metadata(name):
            raise FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT),
                                    path)
        return await self.attrs_for(path, fh)

    async def readdir(self, path: str) -> list[str]:
        """Entry names under a directory, including "." and "..".

        Args:
            path (str): mount path of the directory.

        Returns:
            list[str]: entry names.

        Raises:
            FileNotFoundError: no such directory and nothing virtual there.
        """
        # The ops facade merges namespace structure (child mounts and
        # symlinks) into readdir and answers structure-only directories
        # itself, so the core only normalizes entry shapes and drops
        # macOS metadata names.
        names = set()
        entries = await self._ops.readdir(self.resolve(path))
        for e in entries:
            part = e.rstrip("/").rsplit("/", 1)[-1]
            if part and not is_macos_metadata(part):
                names.add(part)
        return [".", ".."] + sorted(names)

    async def readdir_entries(self, path: str) -> list[MountEntry]:
        """The same listing as :meth:`readdir`, described per entry.

        A protocol that lists with attributes would otherwise stat every
        name again, once per entry per listing, and would have to join
        each child path itself -- which is how an adapter ends up
        disagreeing with the core about what a name resolves to. "." and
        ".." are absent: they are the caller's to emit, and libfuse and
        NFSv3 emit them differently.

        Args:
            path (str): mount path of the directory.

        Returns:
            list[MountEntry]: name, path and attributes per entry.

        Raises:
            FileNotFoundError: no such directory and nothing virtual there.
        """
        entries = []
        for name in await self.readdir(path):
            if name in (".", ".."):
                continue
            child = posixpath.join(path, name)
            entries.append(
                MountEntry(name=name,
                           path=child,
                           attrs=await self.attrs_for(child)))
        return entries

    async def read(self, path: str, size: int, offset: int,
                   fh: int | None) -> bytes:
        """Read a slice of a file.

        Args:
            path (str): mount path to read.
            size (int): maximum number of bytes to return.
            offset (int): byte offset to start at.
            fh (int | None): open handle, when reading through one.

        Returns:
            bytes: the requested slice, possibly short at EOF.
        """
        ctx = self._ctx(fh)
        if ctx is not None and ctx.data is not None:
            return ctx.data[offset:offset + size]
        data = self.cached_data(path)
        if data is None:
            data = await self._ops.read(self.resolve(path))
            # Cache the whole-object fetch here, not only in the one
            # prefetch_read does on open. NFSv3 has no OPEN, so its
            # reads never reached that fill and every 64 KiB READ
            # refetched the entire file: 16 full fetches to serve 1 MiB,
            # and one backend request per 64 KiB on an API mount. The
            # bytes are already in hand, so this costs retention only.
            self._prefetch.put(path, data)
        if ctx is not None:
            ctx.data = data
        return data[offset:offset + size]

    async def store(self, path: str, data: bytes) -> None:
        """Replace a file's whole content.

        The write an adapter that buffers whole objects needs. It exists
        so that adapter does not reach the facade directly: a store that
        bypasses the core also bypasses the cache invalidation, and the
        next read is served pre-write bytes for the rest of the TTL --
        which for a flush means losing the batch the flush before it
        stored.

        Args:
            path (str): mount path to replace.
            data (bytes): the new content.
        """
        await self._ops.write(self.resolve(path), data)
        self._prefetch.invalidate(path)

    async def _apply_writes(self, path: str, writes: WriteBuf) -> None:
        """Merge buffered writes over the raw base and persist the result.

        The base is read raw so a flush never stores a rendered view
        back into the mount.

        Args:
            path (str): mount path being written.
            writes (WriteBuf): (offset, payload) pairs in arrival order.
        """
        existing = b""
        try:
            existing = await self._ops.read(self.resolve(path), raw=True)
        except FileNotFoundError:
            # missing file: start from empty; the write creates it
            pass
        merged = merge_writes(existing, writes)
        await self._ops.write(self.resolve(path), merged)
        self._prefetch.invalidate(path)

    async def write(self, path: str, data: bytes, offset: int,
                    fh: int | None) -> int:
        """Write bytes at an offset, buffering when a handle is open.

        Args:
            path (str): mount path to write.
            data (bytes): payload.
            offset (int): byte offset to write at.
            fh (int | None): open handle; buffers until flush when present.

        Returns:
            int: number of bytes accepted.
        """
        ctx = self._ctx(fh)
        if ctx is not None:
            ctx.write_buf.append((offset, data))
            return len(data)
        await self._apply_writes(path, [(offset, data)])
        return len(data)

    async def create(self, path: str) -> int:
        """Create an empty file and return a fresh handle.

        Args:
            path (str): mount path to create.

        Returns:
            int: the new handle id.
        """
        await self._ops.create(self.resolve(path))
        self._prefetch.invalidate(path)
        return self._handles.add(Handle(path=path))

    async def mkdir(self, path: str) -> None:
        await self._ops.mkdir(self.resolve(path))

    def readlink(self, path: str) -> str:
        """The stored target of a namespace link.

        Args:
            path (str): mount path to read.

        Returns:
            str: the link target.

        Raises:
            OSError: EINVAL when the path is not a link.
        """
        target = self.link_target(path)
        if target is None:
            raise OSError(errno.EINVAL, os.strerror(errno.EINVAL), path)
        return target

    async def symlink(self, target: str, source: str) -> None:
        """Create namespace link ``target -> source`` (ln -s source target).

        Relative sources are stored verbatim (resolved at follow time,
        exactly like the shell ``ln -s``); absolute sources are mapped
        into virtual space so a scoped mount stores the path it will
        later follow. The write routes through the op door like every
        other FUSE op, so session grants and admission policies refuse
        a scoped kernel mount exactly like a scoped shell.

        Args:
            target (str): mount path of the link being created.
            source (str): what the link points to, as typed.

        Raises:
            OSError: EROFS when the workspace has no namespace links.
        """
        if self._ops.links is None:
            raise OSError(errno.EROFS, os.strerror(errno.EROFS), target)
        stored = self.resolve(source) if source.startswith("/") else source
        await self._ops.symlink(self.resolve(target), stored)

    async def unlink(self, path: str) -> None:
        """Remove the entry at ``path``, a link entry like any other.

        A link routes through the op door rather than straight to the
        node table: ``unlink`` is a LINK_ENTRY_OPS member, so the door
        answers a link path itself, gated by session grants and
        admission policies and recorded on the ledger. Writing the
        table here instead let a session-scoped kernel mount delete a
        link on a mount its profile hides.

        Args:
            path (str): mount path of the entry to remove.
        """
        await self._ops.unlink(self.resolve(path))
        self._forget(path)

    async def rename(self, old: str, new: str) -> None:
        await self._ops.rename(self.resolve(old), self.resolve(new))
        moved = self._xattrs.pop(old, None)
        if moved is not None:
            self._xattrs[new] = moved
        self._prefetch.invalidate(old, new)

    async def rmdir(self, path: str) -> None:
        await self._ops.rmdir(self.resolve(path))
        self._xattrs.pop(path, None)

    def statfs(self) -> dict[str, Any]:
        return {
            "f_bsize": 4096,
            "f_frsize": 4096,
            "f_blocks": 1024 * 1024,
            "f_bfree": 1024 * 1024,
            "f_bavail": 1024 * 1024,
            "f_files": 1000000,
            "f_ffree": 1000000,
            "f_favail": 1000000,
            "f_namemax": 255,
        }

    async def setxattr(self, path: str, name: str, value: bytes) -> None:
        """Record an advisory extended attribute for this mount's lifetime.

        Mirage backends (S3, etc.) have no POSIX extended attributes, so
        there is nothing to persist xattrs to. Keeping them in memory per
        mount lets tools that probe or set xattrs (sandbox runtimes, rsync
        -aX, tar --xattrs, cp -p, macOS Finder writing com.apple.*) succeed
        instead of failing with ENOTSUP. The values are intentionally never
        written to the backend.

        Args:
            path (str): mount path the attribute belongs to.
            name (str): attribute name.
            value (bytes): attribute payload.
        """
        await self.getattr(path)
        self._xattrs.setdefault(path, {})[name] = bytes(value)

    async def getxattr(self, path: str, name: str) -> bytes:
        """Read an advisory extended attribute.

        Args:
            path (str): mount path the attribute belongs to.
            name (str): attribute name.

        Returns:
            bytes: the stored payload.

        Raises:
            OSError: ENOATTR/ENODATA when the attribute is not set.
        """
        await self.getattr(path)
        attrs = self._xattrs.get(path)
        if attrs is None or name not in attrs:
            raise OSError(NO_XATTR, os.strerror(NO_XATTR), path)
        return attrs[name]

    async def listxattr(self, path: str) -> list[str]:
        await self.getattr(path)
        return list(self._xattrs.get(path, {}).keys())

    async def removexattr(self, path: str, name: str) -> None:
        await self.getattr(path)
        self._xattrs.get(path, {}).pop(name, None)

    async def flush(self, path: str, fh: int | None) -> None:
        """Merge a handle's buffered writes and persist them.

        Args:
            path (str): mount path being flushed.
            fh (int | None): the handle whose buffer to drain.
        """
        ctx = self._ctx(fh)
        if ctx is None or not ctx.write_buf:
            return
        await self._apply_writes(path, ctx.write_buf)
        ctx.write_buf = []

    async def open(self, path: str) -> int:
        """Open a path, hydrating it when its size is unknown.

        Args:
            path (str): mount path to open.

        Returns:
            int: the new handle id.

        Raises:
            FileNotFoundError: no such entry.
        """
        s = await self._ops.stat(self.resolve(path))
        ctx = Handle(path=path)
        if s.size is None and s.type != FileType.DIRECTORY:
            # API resources cannot size a file without fetching it, so hydrate
            # now: getattr(fh) and read() then serve real bytes, and the TTL
            # cache keeps release-then-stat bursts from refetching.
            ctx.data = await self.prefetch_read(path)
        return self._handles.add(ctx)

    async def release(self, fh: int) -> None:
        ctx = self._handles.get(fh)
        if ctx is not None and ctx.write_buf:
            # The macFUSE FSKit shim issues WRITE then RELEASE with no FLUSH
            # in between (the kext always flushes on close), so a handle can
            # still hold buffered writes here. Dropping them would silently
            # lose data written through an fskit mount.
            await self.flush(ctx.path, fh)
        self._handles.pop(fh)

    async def truncate(self, path: str, length: int) -> None:
        await self._ops.truncate(self.resolve(path), length)
        self._prefetch.invalidate(path)

    def _forget(self, path: str) -> None:
        self._xattrs.pop(path, None)
        self._prefetch.invalidate(path)
