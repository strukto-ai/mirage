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
import functools
import logging
import os
import posixpath
import threading
import time
from typing import Any, Coroutine

from mirage.bridge.sync import run_async_from_sync
from mirage.context import reset_current_session, set_current_session
from mirage.errors.fs import enoent, erofs
from mirage.fuse.platform.macos import is_macos_metadata
from mirage.fuse.types import Handle, WriteBuf
from mirage.policy.match import skipped_at_dispatch
from mirage.runtime.handles import (
    ChunkedHandle,
    FileTable,
    overlaid,
    write_runs,
)
from mirage.runtime.handles.constants import READ_CHUNK
from mirage.types import LIVE_KEY, FileStat, FileType
from mirage.utils.stat_view import (
    DIR_MODE,
    DIR_SIZE,
    atime_ns,
    content_size,
    device_rdev,
    is_dir,
    is_link,
    mtime_ns,
    posix_mode,
)
from mirage.workspace.files import Files
from mirage.workspace.session.session import SessionState

logger = logging.getLogger(__name__)


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
        files (Files): the workspace's ``ws.vfs`` every filesystem call routes to.
        root_prefix (str): mount root; non-empty scopes the tree to one mount.
        session (SessionState | None): bind every op to this session's mount
            grants, exactly as a shell command in that session would run.
            None means unrestricted.
        loop (asyncio.AbstractEventLoop | None): a running loop to run ops
            on, such as the daemon's per-workspace runner loop, so an
            adapter serving a hosted workspace touches it only from the
            loop that owns it. None starts a private loop thread, which is
            what a kernel mount wants.
    """

    def __init__(
        self,
        files: Files,
        root_prefix: str = "",
        session: SessionState | None = None,
        loop: asyncio.AbstractEventLoop | None = None,
    ) -> None:
        self._files = files
        self._session = session
        skipped = (
            skipped_at_dispatch(session.commands)
            if session is not None
            else ()
        )
        if session is not None and skipped:
            # This entry point sees ops, never a line, so the profile's
            # command-level rules have nothing here to judge.
            logger.warning(
                "session %s: an entry point that sees only ops (a kernel "
                "mount, SFTP, codex-exec's file calls) cannot apply %s; "
                "path rules, hides and modes still hold",
                session.session_id,
                "; ".join(skipped),
            )
        self._now = time.time_ns()
        self._root = root_prefix.rstrip("/")
        self._handles: FileTable[Handle] = FileTable()
        # Windows has no getuid/getgid; the values are irrelevant there
        # because the mount passes uid=-1,gid=-1 and WinFsp presents files
        # as owned by the mounting user (see mount.py). Mirrors core.ts.
        self._uid = os.getuid() if hasattr(os, "getuid") else 0
        self._gid = os.getgid() if hasattr(os, "getgid") else 0
        if loop is None:
            loop = asyncio.new_event_loop()
            threading.Thread(target=loop.run_forever, daemon=True).start()
        self._loop = loop

    @property
    def files(self) -> Files:
        return self._files

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
        ``shell`` brackets a command with the session token.

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
            "st_size": DIR_SIZE,
            "st_atime": self._now,
            "st_mtime": self._now,
            "st_ctime": self._now,
        }

    def attrs(self, s: FileStat, size: int | None = None) -> dict[str, Any]:
        """The POSIX attrs for one stat row, the way a guest's stat reads
        it (``runtime/files.py:stat_row``).

        The row carries the namespace overlay (chmod bits, chown ids, a
        touched mtime), so what a metadata op stored is what the mount
        shows. A device keeps its type and numbers. String uid/gid
        (names) fall back to the mounting user: the kernel wants numbers
        and there is no user db to map against. A missing stamp falls
        back to the mount's start time; epoch zero is a real time and
        lands.

        Args:
            s (FileStat): the row the dispatcher answered with.
            size (int | None): the size to report instead of the row's,
                from an open handle or a link's shown target.
        """
        mtime = mtime_ns(s)
        when = self._now if mtime is None else mtime
        atime = atime_ns(s)
        return {
            "st_mode": posix_mode(s),
            "st_nlink": 2 if is_dir(s) else 1,
            "st_uid": s.uid if isinstance(s.uid, int) else self._uid,
            "st_gid": s.gid if isinstance(s.gid, int) else self._gid,
            "st_size": content_size(s) if size is None else size,
            "st_rdev": device_rdev(s),
            "st_atime": when if atime is None else atime,
            "st_mtime": when,
            "st_ctime": when,
        }

    def root_attrs(self) -> dict[str, Any]:
        """The mount root's attrs: its own row through the dispatcher, so a
        chmod made on it shows, or a plain directory when nothing answers
        for it (a workspace with no mount at ``/``).
        """
        try:
            s = self._run(self._files.stat(self.resolve("/")))
        except FileNotFoundError as err:
            logger.debug("fuse: the mount root has no row of its own: %r", err)
            return self.dir_stat()
        return self.attrs(s)

    def shown_target(self, path: str, target: str) -> str:
        """The target to present for a link at a mount path.

        Relative targets are stored verbatim and returned as-is. Absolute
        targets name virtual paths, so they are rewritten relative to the
        link's directory: returned raw, the kernel would resolve them
        against the host root and escape the mountpoint.

        Args:
            path (str): mount path of the link.
            target (str): the stored target, as the dispatcher read it.
        """
        if not target.startswith("/"):
            return target
        virtual_target = target
        if self._root:
            if target == self._root:
                virtual_target = "/"
            elif target.startswith(self._root + "/"):
                virtual_target = target[len(self._root) :]
            else:
                # points outside the scoped root: unreachable through this
                # mount, keep the stored form (a dangling link is legal)
                return target
        parent = path.rsplit("/", 1)[0] or "/"
        return posixpath.relpath(virtual_target, parent)

    def drain_ops(self) -> list[dict[str, Any]]:
        records = [r.to_dict() for r in self._files.records]
        self._files.records.clear()
        return records

    def held_size(self, path: str) -> int | None:
        """The length of the bytes an open handle on the file holds.

        A size-unknown file is read whole when it opens, so while a handle
        is open its length answers a stat by path too (``ls -l`` beside a
        ``cat``). Once every handle is released, the dispatcher answers
        from the workspace cache instead.

        Args:
            path (str): mount path to look up.
        """
        key = self.identity(path)
        for ctx in self._handles.values():
            if ctx.key == key and ctx.data is not None:
                return len(ctx.data)
        return None

    def getattr(
        self, path: str, fh: int | None = None, follow: bool = False
    ) -> dict[str, Any]:
        """POSIX attributes for a path, optionally through an open handle.

        One stat through the dispatcher answers: a link the session cannot
        see is absent, as it is to the shell, and a visible one reports
        its own row with its target read through the dispatcher too.

        Args:
            path (str): mount path to stat.
            fh (int | None): open handle, when the caller is fstat-ing.
            follow (bool): report a trailing link's target rather than
                the link (stat rather than lstat).

        Returns:
            dict: ``st_*`` attribute dict.

        Raises:
            FileNotFoundError: no such entry.
        """
        # fstat(fd) after open: the hydrated handle knows the real byte
        # length, and what the handle wrote and has not flushed counts.
        # attr_timeout=0 on FUSE mounts makes the kernel actually ask here
        # instead of trusting the cached pre-open size, which is what keeps
        # wc -c, BSD cp, and tail -c correct for size-unknown files.
        ctx = self._handles.get(fh) if fh is not None else None
        size = None
        if ctx is not None:
            path = ctx.path
            # The handle is open on the file a link led to, so its stat
            # is the target's.
            follow = True
            if ctx.data is not None:
                size = len(ctx.data)
        if path == "/":
            return self.root_attrs()
        # macOS Finder/Spotlight probes .DS_Store, ._*, .Spotlight-V100, etc.
        # Reject early to avoid hitting the ops layer.
        name = path.rsplit("/", 1)[-1]
        if is_macos_metadata(name):
            raise enoent(path)
        virtual = self.resolve(path)
        try:
            s = self._run(self._files.stat(virtual, nofollow=not follow))
        except FileNotFoundError:
            if size is None:
                raise
            # An open descriptor keeps the bytes it had after an unlink.
            s = FileStat(name=name, type=FileType.FILE)
        if is_link(s):
            target = self._run(self._files.readlink(virtual))
            return self.attrs(s, len(self.shown_target(path, target).encode()))
        if is_dir(s):
            return self.attrs(s)
        if size is None and s.size is None:
            # A size-unknown file the cache has not seen stats as 0,
            # matching mirage's own find semantics. Reads stay correct
            # anyway: direct_io makes the kernel ignore st_size, and the fh
            # branch above serves the real size to fstat-based tools after
            # open. Never report a fake size and never fetch content here:
            # getattr runs once per entry on every ls -l.
            size = self.held_size(path)
        if ctx is not None and ctx.write_buf:
            stored = content_size(s) if size is None else size
            size = max(stored, *(o + len(d) for o, d in ctx.write_buf))
        return self.attrs(s, size)

    def readdir(self, path: str) -> list[str]:
        """Entry names under a directory, including "." and "..".

        Args:
            path (str): mount path of the directory.

        Returns:
            list[str]: entry names.

        Raises:
            FileNotFoundError: no such directory and nothing virtual there.
        """
        # `ws.vfs` merges namespace structure (child mounts and
        # symlinks) into readdir and answers structure-only directories
        # itself, so the core only normalizes entry shapes and drops
        # macOS metadata names.
        names = set()
        entries = self._run(self._files.readdir(self.resolve(path)))
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
        if ctx is None:
            # Whole, as a handle's first read is: the read that fills the
            # cache and records the version a conditional write sends.
            data = self._run(self._files.read(self.resolve(path)))
            return data[offset : offset + size]
        if ctx.live:
            stored = self._run(
                self._files.read(self.resolve(ctx.path), offset, size)
            )
        elif ctx.chunked is not None:
            stored = ctx.chunked.pread(offset, size)
        else:
            if ctx.data is None:
                ctx.data = self._run(self._files.read(self.resolve(ctx.path)))
            stored = ctx.data[offset : offset + size]
        if not ctx.write_buf:
            return stored
        return overlaid(stored, offset, size, ctx.write_buf)

    def _apply_writes(self, path: str, runs: WriteBuf) -> None:
        """Land write runs on the mount, one pwrite each, in order.

        A pwrite keeps every stored byte the handle did not write, so
        nothing is read through the dispatcher first: a session that may write
        a file and not read it writes through FUSE, as through a
        write-only descriptor. The runs that landed leave ``runs`` in one
        step, so after a failure ``runs`` holds only what did not land
        and a retry never replays a run over bytes another writer has
        since put there. A run that fails still invalidates what the core
        holds, since the runs before it have landed.

        Args:
            path (str): mount path being written.
            runs (WriteBuf): (offset, payload) runs; the landed ones are
                removed.
        """
        target = self.resolve(path)
        landed = 0
        try:
            for offset, data in runs:
                self._run(self._files.pwrite(target, data, offset))
                landed += 1
        finally:
            del runs[:landed]
            self._changed(path)

    def write(
        self, path: str, data: bytes, offset: int, fh: int | None
    ) -> int:
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
        self._run(self._files.create(self.resolve(path)))
        self._changed(path)
        return self._handles.add(Handle(path=path, key=self.identity(path)))

    def mkdir(self, path: str) -> None:
        self._run(self._files.mkdir(self.resolve(path)))

    def readlink(self, path: str) -> str:
        """The target of a namespace link, read through the dispatcher.

        Args:
            path (str): mount path to read.

        Returns:
            str: the link target, as this mount shows it.

        Raises:
            OSError: EINVAL when the path is not a link.
        """
        target = self._run(self._files.readlink(self.resolve(path)))
        return self.shown_target(path, target)

    def symlink(self, target: str, source: str) -> None:
        """Create namespace link ``target -> source`` (ln -s source target).

        Relative sources are stored verbatim (resolved at follow time,
        exactly like the shell ``ln -s``); absolute sources are mapped
        into virtual space so a scoped mount stores the path it will
        later follow. The write routes through the dispatcher like every
        other FUSE op, so session grants and admission policies refuse
        a scoped kernel mount exactly like a scoped shell.

        Args:
            target (str): mount path of the link being created.
            source (str): what the link points to, as typed.

        Raises:
            OSError: EROFS when the workspace has no namespace links.
        """
        if self._files.links is None:
            raise erofs(target)
        stored = self.resolve(source) if source.startswith("/") else source
        self._run(self._files.symlink(self.resolve(target), stored))

    def unlink(self, path: str) -> None:
        """Remove the entry at ``path``, a link entry like any other.

        A link routes through the dispatcher rather than straight to the
        node table: ``unlink`` is a LINK_ENTRY_OPS member, so the dispatcher
        answers a link path itself, gated by session grants and
        admission policies and recorded on the ledger. Writing the
        table here instead let a session-scoped kernel mount delete a
        link on a mount its profile hides.

        Args:
            path (str): mount path of the entry to remove.
        """
        self._hold(path)
        self._run(self._files.unlink(self.resolve(path)))

    def rename(self, old: str, new: str) -> None:
        source, target = self.resolve(old), self.resolve(new)
        self._hold(new)
        self._run(self._files.rename(source, target))
        for ctx in self._handles.values():
            if ctx.key == source or ctx.key.startswith(source + "/"):
                ctx.key = target + ctx.key[len(source) :]
                ctx.path = ctx.key[len(self._root) :]

    def rmdir(self, path: str) -> None:
        self._run(self._files.rmdir(self.resolve(path)))

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

    def setattr(
        self,
        path: str,
        mode: int | None = None,
        uid: int | None = None,
        gid: int | None = None,
    ) -> None:
        """Store metadata through the dispatcher.

        The backend keeps what it can and the namespace overlay the rest,
        so a chmod or chown through the mount is what ``stat`` in a shell
        reads back, on a backend with no permission bits of its own too.
        The kernel has already resolved any link the call follows, so the
        path names the entry to change, a link itself for ``chown -h``.

        Args:
            path (str): mount path to change.
            mode (int | None): permission bits; None leaves them.
            uid (int | None): owner id; None leaves it.
            gid (int | None): group id; None leaves it.
        """
        self._run(
            self._files.setattr(
                self.resolve(path),
                mode=None if mode is None else mode & 0o7777,
                uid=uid,
                gid=gid,
                nofollow=True,
            )
        )

    def setxattr(
        self,
        path: str,
        name: str,
        value: bytes,
        create: bool = False,
        replace: bool = False,
    ) -> None:
        """Store an extended attribute through the dispatcher.

        The dispatcher keeps it on the path's namespace node, so it outlives
        the mount, moves with a rename, and is the same attribute every
        other surface (the shell's getfattr, a guest's os.getxattr)
        reads. Tools that set xattrs as a matter of course (rsync -aX,
        tar --xattrs, cp -p, Finder writing com.apple.*) succeed on a
        backend with no attribute slot of its own.

        Args:
            path (str): mount path the attribute belongs to.
            name (str): attribute name.
            value (bytes): attribute payload.
            create (bool): refuse with EEXIST when it is already set.
            replace (bool): refuse when it is not set yet.
        """
        self._run(
            self._files.setxattr(
                self.resolve(path),
                name,
                bytes(value),
                create=create,
                replace=replace,
            )
        )

    def getxattr(self, path: str, name: str) -> bytes:
        """Read an extended attribute, the backend's own facts included.

        Args:
            path (str): mount path the attribute belongs to.
            name (str): attribute name.

        Returns:
            bytes: the stored payload.

        Raises:
            OSError: ENOATTR/ENODATA when the attribute is not set.
        """
        return bytes(self._run(self._files.getxattr(self.resolve(path), name)))

    def listxattr(self, path: str) -> list[str]:
        return list(self._run(self._files.listxattr(self.resolve(path))))

    def removexattr(self, path: str, name: str) -> None:
        self._run(self._files.removexattr(self.resolve(path), name))

    def flush(self, path: str, fh: int | None) -> None:
        """Merge a handle's buffered writes and persist them.

        Args:
            path (str): mount path being flushed.
            fh (int | None): the handle whose buffer to drain.
        """
        ctx = self._ctx(fh)
        if ctx is None or not ctx.write_buf:
            return
        ctx.write_buf = write_runs(ctx.write_buf)
        self._apply_writes(ctx.path, ctx.write_buf)

    def open(self, path: str, flags: int = 0) -> int:
        """Open a path, hydrating it when its size is unknown.

        Args:
            path (str): mount path to open.
            flags (int): the open(2) flags the kernel passed. Only
                ``O_TRUNC`` is read here.

        Returns:
            int: the new handle id.

        Raises:
            FileNotFoundError: no such entry.
        """
        s = self._run(self._files.stat(self.resolve(path)))
        ctx = Handle(
            path=path,
            key=self.identity(path),
            live=s.extra.get(LIVE_KEY) is True,
        )
        if s.type == FileType.DIRECTORY:
            return self._handles.add(ctx)
        if flags & os.O_TRUNC:
            # libfuse 3 negotiates FUSE_CAP_ATOMIC_O_TRUNC by default, so the
            # kernel sends no SETATTR ahead of an O_TRUNC open: the flag on
            # the open is the whole truncation. libfuse 2 (macFUSE, the
            # libfuse2 CI installs) strips the flag and truncates through
            # setattr first, which is why dropping it here only showed on a
            # fuse3-only host, where a shorter overwrite kept the old tail.
            self.truncate(path, 0)
        if ctx.live:
            return self._handles.add(ctx)
        if s.size is None:
            # API-backed mounts cannot size a file without fetching it, so
            # hydrate now: getattr(fh) and read() then serve real bytes, and
            # the TTL cache keeps release-then-stat bursts from refetching.
            # This holds after an O_TRUNC too: the read follows the rendered
            # path, so an extension whose renderer gives an empty file a body
            # is honored rather than shadowed by literal raw emptiness. The
            # read goes through the dispatcher, so a caching mount keeps the
            # bytes for the next open and for a stat once this one closes.
            ctx.data = self._hydrate(path)
        elif s.size > READ_CHUNK and not flags & os.O_TRUNC:
            # A file larger than a chunk is read a chunk at a time: the
            # kernel asks in small pieces, and fetching the whole file on
            # the first one moved all of it to answer a `head`.
            ctx.chunked = ChunkedHandle(
                path=path,
                size=s.size,
                fetch=functools.partial(self._read_chunk, ctx),
            )
        return self._handles.add(ctx)

    def _hydrate(self, path: str) -> bytes | None:
        """Read a size-unknown file whole for the handle opening it.

        Returns None when the read fails for any reason: open() stays
        permissive, as the TypeScript core does, and the read() that
        follows surfaces the error. This matters most after an O_TRUNC,
        whose truncation has already committed by the time this runs:
        failing the open then would erase the old body and refuse the
        replacement.

        Args:
            path (str): mount path being opened.
        """
        try:
            return self._run(self._files.read(self.resolve(path)))
        except Exception as err:
            logger.debug(
                "fuse: hydration read of %s failed, deferring to read(): %r",
                path,
                err,
            )
            return None

    def _read_chunk(self, ctx: Handle, offset: int, size: int) -> bytes:
        # The handle's path as it is now: a rename moves it.
        return self._run(
            self._files.read(self.resolve(ctx.path), offset, size)
        )

    def _hold(self, path: str) -> None:
        """Read the rest of the chunked handles on ``path`` before it goes.

        POSIX keeps an open descriptor on the bytes it had, and a chunked
        handle holds one chunk of them, so an unlink or a rename onto the
        file would leave the rest unreadable. One read serves every such
        handle; FUSE runs single-threaded here, so none opens meanwhile. A
        read that fails (a policy may allow the removal and refuse the
        read) leaves them chunked rather than refusing a mutation the
        caller is allowed.

        Args:
            path (str): mount path about to be removed or replaced.
        """
        links = self._files.links
        if links is not None and links.is_link(self.resolve(path)):
            # Removing a link entry takes the link, never its target's
            # bytes.
            return
        key = self.identity(path)
        held = [
            ctx
            for ctx in self._handles.values()
            if ctx.key == key and ctx.chunked is not None
        ]
        if not held:
            return
        try:
            data = self._run(self._files.read(self.resolve(path)))
        except Exception as err:
            logger.debug(
                "fuse: holding %s before it goes failed: %r", path, err
            )
            return
        for ctx in held:
            ctx.data = data
            ctx.chunked = None

    def release(self, fh: int) -> None:
        ctx = self._handles.get(fh)
        if ctx is not None and ctx.write_buf:
            # The macFUSE FSKit shim issues WRITE then RELEASE with no FLUSH
            # in between (the kext always flushes on close), so a handle can
            # still hold buffered writes here. Dropping them would silently
            # lose data written through an fskit mount.
            self.flush(ctx.path, fh)
        self._handles.pop(fh)

    def identity(self, path: str) -> str:
        """Where a mount path really points: the mount-resolved path with
        every namespace link followed, so two handles opened through a
        link and its target are recognised as the same file.

        Args:
            path (str): mount path to identify.
        """
        virtual = self.resolve(path)
        links = self._files.links
        return virtual if links is None else links.follow(virtual)

    def truncate(self, path: str, length: int) -> None:
        """Resize a file, settling every open handle on the same file.

        A write the kernel already acknowledged on another handle precedes
        this truncation in POSIX order, so it is flushed first rather than
        left queued to land over the shortened file at that handle's
        release. Handles are matched by identity, not by the path they
        were opened through, so a link alias is settled too. Hydrated
        handles are then rehydrated from the resized file, so fstat and
        read through them see the settled writes and the new length
        rather than the bytes they opened on.

        Args:
            path (str): mount path to resize.
            length (int): the new byte length.
        """
        key = self.identity(path)
        for ctx in self._handles.values():
            if ctx.key == key and ctx.write_buf:
                ctx.write_buf = write_runs(ctx.write_buf)
                self._apply_writes(ctx.path, ctx.write_buf)
        self._run(self._files.truncate(self.resolve(path), length))
        self._changed(path)

    def _changed(self, path: str) -> None:
        """The one function every mutation of a file's bytes goes through.

        The open handles on a file are matched by its identity (the
        mount path with namespace links followed), and this is the only
        place their bytes are refreshed, so a new mutating op cannot
        forget one of them and a link alias cannot slip past. Hydrated
        handles on the file are refreshed in one read through the
        dispatcher, so fstat and read through any of them, including the
        handle that wrote, see the new bytes. A refresh that fails is
        logged and leaves the handles unhydrated rather than failing the
        committed mutation. A removal or rename refreshes nothing: POSIX
        keeps an open descriptor on the bytes it had.

        Args:
            path (str): mount path whose bytes changed.
        """
        key = self.identity(path)
        for ctx in self._handles.values():
            if ctx.key == key and ctx.chunked is not None:
                ctx.chunked.drop()
        hydrated = [
            ctx
            for ctx in self._handles.values()
            if ctx.key == key and ctx.data is not None
        ]
        if not hydrated:
            return
        try:
            data = self._run(self._files.read(self.resolve(path)))
        except Exception as err:
            # The mutation has already landed, so a refresh that fails must
            # not report it as failed: an O_TRUNC open would fail after the
            # old bytes were erased, and settled writes would be retried
            # over content that already holds them. Drop the hydrated bytes
            # instead, so the next read through those handles fetches and
            # surfaces any error itself.
            logger.warning(
                "fuse: refresh of %s after a change failed: %r", path, err
            )
            for ctx in hydrated:
                ctx.data = None
            return
        for ctx in hydrated:
            ctx.data = data
