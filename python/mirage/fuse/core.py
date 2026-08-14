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
import os
import posixpath
import stat
import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Coroutine

from mirage.bridge.sync import run_async_from_sync
from mirage.context import reset_current_session, set_current_session
from mirage.fuse.errors import NO_XATTR
from mirage.fuse.platform.macos import is_macos_metadata
from mirage.ops import Ops
from mirage.runtime.handles import FileTable, merge_writes
from mirage.types import FileStat, FileType
from mirage.utils.stat_view import DIR_MODE, FILE_MODE, mtime_ns
from mirage.workspace.session.session import Session

# How long prefetched bytes for size-unknown files outlive their handle, so a
# release-then-stat burst (ls right after cat) neither refetches nor reports
# an unknown size. Mirrors the TS PREFETCH_TTL_MS.
PREFETCH_TTL = 30.0

WriteBuf = list[tuple[int, bytes]]


@dataclass(slots=True)
class Handle:
    path: str
    data: bytes | None = None
    write_buf: WriteBuf = field(default_factory=list)


class MountCore:
    """Protocol-neutral mount logic shared by every kernel adapter.

    Everything here is expressed in POSIX terms (``st_*`` attribute dicts,
    ordinary Python exceptions) and imports nothing from mfusepy, so it is
    reusable by a non-FUSE adapter (FSKit, File Provider) and unit-testable
    without a kernel or the ``[fuse]`` extra installed.

    The division of labour: this class decides *what* the filesystem
    contains, an adapter decides *how* to say it to a particular kernel
    interface. Adapters translate the exceptions raised here into their own
    error codes with ``mirage.fuse.errors.classify_error``.

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
        self._ops = ops
        self._session = session
        self._now = time.time_ns()
        self._root = root_prefix.rstrip("/")
        self._handles: FileTable[Handle] = FileTable()
        # Prefetched content for size-unknown files: path -> (data, expiry).
        self._prefetch: dict[str, tuple[bytes, float]] = {}
        # In-memory extended attributes, keyed by path. Backends have no
        # POSIX xattrs, so these are advisory, not persisted (see setxattr).
        self._xattrs: dict[str, dict[str, bytes]] = {}
        # Windows has no getuid/getgid; the values are irrelevant there
        # because the mount passes uid=-1,gid=-1 and WinFsp presents files
        # as owned by the mounting user (see mount.py). Mirrors fs.ts.
        self._uid = os.getuid() if hasattr(os, "getuid") else 0
        self._gid = os.getgid() if hasattr(os, "getgid") else 0
        self._loop = asyncio.new_event_loop()
        self._loop_thread = threading.Thread(target=self._loop.run_forever,
                                             daemon=True)
        self._loop_thread.start()

    @property
    def ops(self) -> Ops:
        return self._ops

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

    def _run(self, coro: Coroutine[Any, Any, Any]) -> Any:
        if self._session is not None:
            coro = self._bind_session(coro)
        return run_async_from_sync(coro, self._loop)

    async def _bind_session(self, coro: Coroutine[Any, Any, Any]) -> Any:
        """Run one op under the bound session's mount grants.

        The session context is set inside the coroutine so it lands on
        the event-loop task that executes the op, mirroring how
        ``execute`` brackets a command with the session token.

        Args:
            coro (Coroutine): the op coroutine to run under the session.

        Returns:
            Any: whatever the wrapped coroutine returns.
        """
        token = set_current_session(self._session)
        try:
            return await coro
        finally:
            reset_current_session(token)

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

    def dir_stat(self) -> dict[str, Any]:
        return {
            "st_mode": DIR_MODE,
            "st_nlink": 2,
            "st_uid": self._uid,
            "st_gid": self._gid,
            "st_size": 0,
            "st_atime": self._now,
            "st_mtime": self._now,
            "st_ctime": self._now,
        }

    def file_stat(self, size: int) -> dict[str, Any]:
        return {
            "st_mode": FILE_MODE,
            "st_nlink": 1,
            "st_uid": self._uid,
            "st_gid": self._gid,
            "st_size": size,
            "st_atime": self._now,
            "st_mtime": self._now,
            "st_ctime": self._now,
        }

    def _apply_stat_attrs(self, entry: dict[str, Any],
                          s: FileStat) -> dict[str, Any]:
        """Fold merged stat attributes into a POSIX attr dict.

        The ops stat already carries the namespace overlay (chmod bits,
        chown ids, touched mtime), so honoring these fields here is what
        makes metadata ops visible through a mount. String uid/gid (names)
        are skipped: the kernel wants numeric ids and there is no user db
        to map against.

        Args:
            entry (dict): base attr dict from dir_stat/file_stat.
            s (FileStat): the merged stat returned by the ops facade.

        Returns:
            dict: the attr dict with overlay fields applied.
        """
        if s.mode is not None:
            entry["st_mode"] = (entry["st_mode"] & ~0o7777) | (s.mode & 0o7777)
        if isinstance(s.uid, int):
            entry["st_uid"] = s.uid
        if isinstance(s.gid, int):
            entry["st_gid"] = s.gid
        if s.modified is not None:
            # One translator per language: the naive-stamp-is-UTC rule
            # lives in stat_view, never re-parsed here. None means the
            # stamp did not parse; epoch zero is a real time and lands.
            ns = mtime_ns(s)
            if ns is not None:
                entry["st_mtime"] = ns
                entry["st_ctime"] = ns
        return entry

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

    def link_stat(self, target: str) -> dict[str, Any]:
        entry = self.file_stat(len(target.encode()))
        entry["st_mode"] = stat.S_IFLNK | 0o777
        return entry

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
        entry = self._prefetch.get(path)
        if entry is None:
            return None
        data, expires = entry
        if time.monotonic() >= expires:
            del self._prefetch[path]
            return None
        return data

    def cached_size(self, path: str) -> int | None:
        """Return the real size of prefetched data, if any is cached.

        Args:
            path (str): mount path to look up.

        Returns:
            int | None: byte length of cached content, or None.
        """
        data = self.cached_data(path)
        return len(data) if data is not None else None

    def prefetch_read(self, path: str) -> bytes | None:
        """Fetch and cache the bytes of a size-unknown file.

        Args:
            path (str): mount path being opened.

        Returns:
            bytes | None: file content, or None when the backend read fails
            (open() stays permissive; the subsequent read() surfaces the
            error to the caller).
        """
        data = self.cached_data(path)
        if data is not None:
            return data
        try:
            data = self._run(self._ops.read(self.resolve(path)))
        except (FileNotFoundError, ValueError):
            return None
        # No inflight dedup: FUSE mounts run nothreads=True, so callbacks are
        # serialized and two opens cannot race (TS needs the dedup map).
        self._prefetch[path] = (data, time.monotonic() + PREFETCH_TTL)
        return data

    def getattr(self, path: str, fh: int | None = None) -> dict[str, Any]:
        """POSIX attributes for a path, optionally through an open handle.

        Args:
            path (str): mount path to stat.
            fh (int | None): open handle, when the caller is fstat-ing.

        Returns:
            dict: ``st_*`` attribute dict.

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
        # macOS Finder/Spotlight probes .DS_Store, ._*, .Spotlight-V100, etc.
        # Reject early to avoid hitting the ops layer.
        name = path.rsplit("/", 1)[-1]
        if is_macos_metadata(name):
            raise FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT),
                                    path)
        # Link check must precede the ops stat: the ops facade follows
        # namespace links, so stat on a link path reports the target.
        target = self.link_target(path)
        if target is not None:
            return self.link_stat(target)
        s = self._run(self._ops.stat(self.resolve(path)))
        if s.type == FileType.DIRECTORY:
            return self._apply_stat_attrs(self.dir_stat(), s)
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
        return self._apply_stat_attrs(self.file_stat(size), s)

    def readdir(self, path: str) -> list[str]:
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
        entries = self._run(self._ops.readdir(self.resolve(path)))
        for e in entries:
            part = e.rstrip("/").rsplit("/", 1)[-1]
            if part and not is_macos_metadata(part):
                names.add(part)
        return [".", ".."] + sorted(names)

    def read(self, path: str, size: int, offset: int, fh: int | None) -> bytes:
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
            data = self._run(self._ops.read(self.resolve(path)))
        if ctx is not None:
            ctx.data = data
        return data[offset:offset + size]

    def _apply_writes(self, path: str, writes: WriteBuf) -> None:
        """Merge buffered writes over the raw base and persist the result.

        The base is read raw so a flush never stores a rendered view
        back into the mount.

        Args:
            path (str): mount path being written.
            writes (WriteBuf): (offset, payload) pairs in arrival order.
        """
        existing = b""
        try:
            existing = self._run(self._ops.read(self.resolve(path), raw=True))
        except FileNotFoundError:
            # missing file: start from empty; the write creates it
            pass
        merged = merge_writes(existing, writes)
        self._run(self._ops.write(self.resolve(path), merged))
        self._prefetch.pop(path, None)

    def write(self, path: str, data: bytes, offset: int,
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
        self._apply_writes(path, [(offset, data)])
        return len(data)

    def create(self, path: str) -> int:
        """Create an empty file and return a fresh handle.

        Args:
            path (str): mount path to create.

        Returns:
            int: the new handle id.
        """
        self._run(self._ops.create(self.resolve(path)))
        self._prefetch.pop(path, None)
        return self._handles.add(Handle(path=path))

    def mkdir(self, path: str) -> None:
        self._run(self._ops.mkdir(self.resolve(path)))

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

    def symlink(self, target: str, source: str) -> None:
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
        self._run(self._ops.symlink(self.resolve(target), stored))

    def unlink(self, path: str) -> None:
        links = self._ops.links
        if links is not None and links.is_link(self.resolve(path)):
            self._run(links.unlink(self.resolve(path)))
            self._forget(path)
            return
        self._run(self._ops.unlink(self.resolve(path)))
        self._forget(path)

    def rename(self, old: str, new: str) -> None:
        self._run(self._ops.rename(self.resolve(old), self.resolve(new)))
        moved = self._xattrs.pop(old, None)
        if moved is not None:
            self._xattrs[new] = moved
        self._prefetch.pop(old, None)
        self._prefetch.pop(new, None)

    def rmdir(self, path: str) -> None:
        self._run(self._ops.rmdir(self.resolve(path)))
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

    def setxattr(self, path: str, name: str, value: bytes) -> None:
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
        self.getattr(path)
        self._xattrs.setdefault(path, {})[name] = bytes(value)

    def getxattr(self, path: str, name: str) -> bytes:
        """Read an advisory extended attribute.

        Args:
            path (str): mount path the attribute belongs to.
            name (str): attribute name.

        Returns:
            bytes: the stored payload.

        Raises:
            OSError: ENOATTR/ENODATA when the attribute is not set.
        """
        self.getattr(path)
        attrs = self._xattrs.get(path)
        if attrs is None or name not in attrs:
            raise OSError(NO_XATTR, os.strerror(NO_XATTR), path)
        return attrs[name]

    def listxattr(self, path: str) -> list[str]:
        self.getattr(path)
        return list(self._xattrs.get(path, {}).keys())

    def removexattr(self, path: str, name: str) -> None:
        self.getattr(path)
        self._xattrs.get(path, {}).pop(name, None)

    def flush(self, path: str, fh: int | None) -> None:
        """Merge a handle's buffered writes and persist them.

        Args:
            path (str): mount path being flushed.
            fh (int | None): the handle whose buffer to drain.
        """
        ctx = self._ctx(fh)
        if ctx is None or not ctx.write_buf:
            return
        self._apply_writes(path, ctx.write_buf)
        ctx.write_buf = []

    def open(self, path: str) -> int:
        """Open a path, hydrating it when its size is unknown.

        Args:
            path (str): mount path to open.

        Returns:
            int: the new handle id.

        Raises:
            FileNotFoundError: no such entry.
        """
        s = self._run(self._ops.stat(self.resolve(path)))
        ctx = Handle(path=path)
        if s.size is None and s.type != FileType.DIRECTORY:
            # API resources cannot size a file without fetching it, so hydrate
            # now: getattr(fh) and read() then serve real bytes, and the TTL
            # cache keeps release-then-stat bursts from refetching.
            ctx.data = self.prefetch_read(path)
        return self._handles.add(ctx)

    def release(self, fh: int) -> None:
        ctx = self._handles.get(fh)
        if ctx is not None and ctx.write_buf:
            # The macFUSE FSKit shim issues WRITE then RELEASE with no FLUSH
            # in between (the kext always flushes on close), so a handle can
            # still hold buffered writes here. Dropping them would silently
            # lose data written through an fskit mount.
            self.flush(ctx.path, fh)
        self._handles.pop(fh)

    def truncate(self, path: str, length: int) -> None:
        self._run(self._ops.truncate(self.resolve(path), length))
        self._prefetch.pop(path, None)

    def _forget(self, path: str) -> None:
        self._xattrs.pop(path, None)
        self._prefetch.pop(path, None)
