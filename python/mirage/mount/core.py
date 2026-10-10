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
import logging
import os
import posixpath
import time
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from mirage.context import reset_current_session, set_current_session
from mirage.errors.fs import enoent
from mirage.mount.platform.macos import is_macos_metadata
from mirage.mount.types import Handle, MountAttrs, WriteBuf
from mirage.policy.match import skipped_at_dispatch
from mirage.runtime.handles import (
    ChunkedHandle,
    FileTable,
    overlaid,
    write_runs,
)
from mirage.runtime.handles.constants import READ_CHUNK
from mirage.types import LIVE_KEY, FileStat, FileType
from mirage.utils.dates import ns_to_iso
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

T = TypeVar("T")


class MountCore:
    """Protocol-neutral mount logic shared by every kernel adapter.

    Async, like ``core.ts``: a sync adapter (libfuse) owns the loop it
    bridges to; SFTP and codex-exec await the core on the workspace's
    loop. It decides what the filesystem holds, in POSIX terms
    (``MountAttrs``, Python exceptions), and an adapter how to say it to
    its kernel, its errnos from ``mirage.mount.errors.classify_error``.

    Ops on one file interleave at their awaits, so its mutations run one
    at a time (``_mutate``), an open and a removal of one name wait for
    each other (``_removing``), and a read waits for a flush landing.

    Args:
        files (Files): the workspace's ``ws.vfs`` every filesystem call routes to.
        root_prefix (str): mount root; non-empty scopes the tree to one mount.
        session (SessionState | None): bind every op to this session's mount
            grants, exactly as a shell command in that session would run.
            None means unrestricted.
    """

    def __init__(
        self,
        files: Files,
        root_prefix: str = "",
        session: SessionState | None = None,
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
        # Per file identity: the hydration read out (opens share it), a
        # generation a change under it bumps, the chain of mutations, the
        # chain of removals, and the opens out that a removal waits for.
        self._hydrations: dict[str, asyncio.Future[bytes | None]] = {}
        self._hydration_gen: dict[str, int] = {}
        self._pending: dict[str, asyncio.Future[None]] = {}
        self._removals: dict[str, asyncio.Future[None]] = {}
        self._opening: dict[str, set[asyncio.Future[None]]] = {}
        # Windows has none; WinFsp presents files as the mounting user's.
        self._uid = os.getuid() if hasattr(os, "getuid") else 0
        self._gid = os.getgid() if hasattr(os, "getgid") else 0

    @property
    def files(self) -> Files:
        return self._files

    @property
    def handles(self) -> FileTable[Handle]:
        return self._handles

    async def _op(self, call: Awaitable[T]) -> T:
        """Run one op under the bound session's mount grants, set around
        the await as ``shell`` brackets a command.

        Args:
            call (Awaitable[T]): the op to run under the session.
        """
        if self._session is None:
            return await call
        token = set_current_session(self._session)
        try:
            return await call
        finally:
            reset_current_session(token)

    async def _queue(
        self,
        queues: dict[str, asyncio.Future[None]],
        key: str,
        fn: Callable[[], Awaitable[T]],
    ) -> T:
        """Run ``fn`` after every call already queued under ``key``, and
        let the next one wait for it, whether it returns or raises.

        Args:
            queues (dict[str, asyncio.Future[None]]): the chains to join.
            key (str): the file identity the chain is for.
            fn (Callable[[], Awaitable[T]]): the work to run in turn.
        """
        prev = queues.get(key)
        done: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        queues[key] = done

        def settle(_: asyncio.Future[None] | None = None) -> None:
            if not done.done():
                done.set_result(None)
            if queues.get(key) is done:
                del queues[key]

        try:
            if prev is not None:
                await asyncio.shield(prev)
            return await fn()
        finally:
            if prev is None or prev.done():
                settle()
            else:
                # Cancelled while waiting its turn: the next in line still
                # waits for the one ahead of this.
                prev.add_done_callback(settle)

    def _mutate(
        self, key: str, fn: Callable[[], Awaitable[T]]
    ) -> Awaitable[T]:
        """Run one mutation of a file after every mutation already queued
        for it. Serialization is per identity, so a flush through a link
        and a truncate through its target queue behind each other.

        Args:
            key (str): the file identity.
            fn (Callable[[], Awaitable[T]]): the mutation.
        """
        return self._queue(self._pending, key, fn)

    def _queue_all(
        self,
        queues: dict[str, asyncio.Future[None]],
        keys: list[str],
        fn: Callable[[], Awaitable[T]],
    ) -> Awaitable[T]:
        """Run ``fn`` holding the chain of every key, taken in sorted order
        so two callers that hold the same pair never wait on each other.

        Args:
            queues (dict[str, asyncio.Future[None]]): the chains to join.
            keys (list[str]): the file identities.
            fn (Callable[[], Awaitable[T]]): the work to run.
        """
        first, *rest = sorted(set(keys))
        if not rest:
            return self._queue(queues, first, fn)
        return self._queue(
            queues, first, lambda: self._queue_all(queues, rest, fn)
        )

    def _removing(
        self, paths: list[str], fn: Callable[[], Awaitable[None]]
    ) -> Awaitable[None]:
        """Run ``fn``, which removes, replaces or moves the files at
        ``paths``, after the opens of those names already out, with later
        ones held back until it is done, as the kernel orders an open and
        an unlink or a rename of one name. Chains of their own, taken
        before any ``_pending`` one, rather than ``_pending`` itself: an
        open they wait for may be truncating there.

        Args:
            paths (list[str]): mount paths being removed, replaced or
                moved.
            fn (Callable[[], Awaitable[None]]): the removal.
        """
        keys = [self.identity(path, follow=False) for path in paths]

        async def run() -> None:
            opening = [
                out for key in keys for out in self._opening.get(key, ())
            ]
            if opening:
                await asyncio.wait(opening)
            await fn()

        return self._queue_all(self._removals, keys, run)

    async def _settled(self, ctx: Handle) -> None:
        """Wait for a flush or truncation of the handle's file still
        landing, into the queue a rename moved the handle to.

        Args:
            ctx (Handle): the handle about to be read or stat'd.
        """
        key = None
        while key != ctx.key:
            key = ctx.key
            tail = self._pending.get(key)
            if tail is not None:
                await asyncio.shield(tail)

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
        return MountAttrs(
            mode=DIR_MODE,
            size=DIR_SIZE,
            nlink=2,
            uid=self._uid,
            gid=self._gid,
            rdev=0,
            atime=self._now,
            mtime=self._now,
            ctime=self._now,
        )

    def attrs(self, s: FileStat, size: int | None = None) -> MountAttrs:
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
        return MountAttrs(
            mode=posix_mode(s),
            size=content_size(s) if size is None else size,
            nlink=2 if is_dir(s) else 1,
            uid=s.uid if isinstance(s.uid, int) else self._uid,
            gid=s.gid if isinstance(s.gid, int) else self._gid,
            rdev=device_rdev(s),
            atime=when if atime is None else atime,
            mtime=when,
            ctime=when,
        )

    async def root_attrs(self) -> MountAttrs:
        """The mount root's attrs: its own row through the dispatcher, so a
        chmod made on it shows, or a plain directory when nothing answers
        for it (a workspace with no mount at ``/``).
        """
        try:
            s = await self._op(self._files.stat(self.resolve("/")))
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

    def held_size(self, path: str) -> int | None:
        """The length of the bytes an open handle on the file holds.

        A size-unknown file is read whole when it opens, so while a handle
        is open its length answers a stat by path too (``ls -l`` beside a
        ``cat``). Once every handle is released, the dispatcher answers
        from the workspace cache instead.

        Args:
            path (str): mount path to look up.
        """
        for ctx in self._open_on(self.identity(path)):
            if ctx.data is not None:
                return len(ctx.data)
        return None

    async def getattr(
        self, path: str, follow: bool = False, ctx: Handle | None = None
    ) -> MountAttrs:
        """POSIX attributes for a path.

        One stat through the dispatcher answers: a link the session cannot
        see is absent, as it is to the shell, and a visible one reports
        its own row with its target read through the dispatcher too.

        Args:
            path (str): mount path to stat.
            follow (bool): report a trailing link's target rather than
                the link (stat rather than lstat).
            ctx (Handle | None): the open handle a fstat reads through;
                what it holds and has not flushed counts.

        Returns:
            MountAttrs: the entry's attributes.

        Raises:
            FileNotFoundError: no such entry.
        """
        size = None if ctx is None or ctx.data is None else len(ctx.data)
        if path == "/":
            return await self.root_attrs()
        # macOS Finder/Spotlight probes .DS_Store, ._*, .Spotlight-V100, etc.
        # Reject early to avoid hitting the ops layer.
        name = path.rsplit("/", 1)[-1]
        if is_macos_metadata(name):
            raise enoent(path)
        virtual = self.resolve(path)
        if ctx is not None and ctx.detached is not None:
            # Its name is gone: it stats by the row its file had then.
            s = ctx.detached
        else:
            try:
                s = await self._op(
                    self._files.stat(virtual, nofollow=not follow)
                )
            except FileNotFoundError:
                if size is None:
                    raise
                # An open descriptor keeps the bytes it had after an unlink.
                s = FileStat(name=name, type=FileType.FILE)
        if is_link(s):
            target = await self._op(self._files.readlink(virtual))
            return self.attrs(s, len(self.shown_target(path, target).encode()))
        if is_dir(s):
            return self.attrs(s)
        if size is None and s.size is None:
            # A size-unknown file stats as 0 rather than be fetched on
            # every ls -l; direct_io keeps its reads whole regardless.
            size = self.held_size(path)
        if ctx is not None and ctx.write_buf:
            stored = content_size(s) if size is None else size
            size = max(stored, *(o + len(d) for o, d in ctx.write_buf))
        return self.attrs(s, size)

    async def fgetattr(self, path: str, fh: int | None) -> MountAttrs:
        """Attributes through an open handle: the path's row, with the
        size the handle holds, what it wrote and has not flushed included.

        Args:
            path (str): mount path the kernel named.
            fh (int | None): the open handle; None stats by path.
        """
        ctx = self._handles.get(fh) if fh is not None else None
        if ctx is None:
            return await self.getattr(path)
        await self._settled(ctx)
        return await self.getattr(ctx.path, True, ctx)

    async def readdir(self, path: str) -> list[str]:
        """Entry names under a directory, including "." and "..".

        Args:
            path (str): mount path of the directory.

        Returns:
            list[str]: entry names.

        Raises:
            FileNotFoundError: no such directory and nothing virtual there.
        """
        names = set()
        entries = await self._op(self._files.readdir(self.resolve(path)))
        for e in entries:
            part = e.rstrip("/").rsplit("/", 1)[-1]
            if part and not is_macos_metadata(part):
                names.add(part)
        return [".", ".."] + sorted(names)

    async def read(
        self, path: str, size: int, offset: int, fh: int | None
    ) -> bytes:
        """Read a slice of a file.

        Args:
            path (str): mount path to read.
            size (int): maximum number of bytes to return.
            offset (int): byte offset to start at.
            fh (int | None): open handle, when reading through one.

        Returns:
            bytes: the requested slice, possibly short at EOF.
        """
        ctx = self._handles.get(fh) if fh is not None else None
        if ctx is None:
            # Whole, as a handle's first read is: the read that fills the
            # cache and records the version a conditional write sends.
            data = await self._op(self._files.read(self.resolve(path)))
            return data[offset : offset + size]
        # A flush still landing has taken the handle's buffer and not yet
        # refreshed its bytes: wait for it, so the read sees what was
        # written.
        await self._settled(ctx)
        if ctx.live:
            stored = await self._op(
                self._files.read(self.resolve(ctx.path), offset, size)
            )
        elif ctx.chunked is not None and ctx.data is None:
            stored = await self._read_chunk(ctx, ctx.chunked, offset, size)
        else:
            held = ctx.data
            if held is None:
                # A change landing while this read is out keeps it from
                # holding what it fetched.
                generation = ctx.generation
                held = await self._op(self._files.read(self.resolve(ctx.path)))
                if ctx.generation == generation:
                    ctx.data = held
            stored = held[offset : offset + size]
        if not ctx.write_buf:
            return stored
        return overlaid(stored, offset, size, ctx.write_buf)

    async def _apply_writes(self, path: str, runs: WriteBuf) -> None:
        """Land write runs on the mount, one pwrite each, in order.

        A pwrite keeps every stored byte the handle did not write, so
        nothing is read through the dispatcher first: a session that may
        write a file and not read it writes through FUSE, as through a
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
                await self._op(self._files.pwrite(target, data, offset))
                landed += 1
        finally:
            del runs[:landed]
            await self._changed(path)

    async def write(
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
        ctx = self._handles.get(fh) if fh is not None else None
        if ctx is not None:
            ctx.write_buf.append((offset, data))
            return len(data)
        await self._mutate(
            self.identity(path),
            lambda: self._apply_writes(path, [(offset, data)]),
        )
        return len(data)

    async def create(self, path: str, mode: int | None = None) -> int:
        """Create an empty file and return a fresh handle.

        Args:
            path (str): mount path to create.
            mode (int | None): the mode the creator asked for, umask
                applied; None takes the mount's default.

        Returns:
            int: the new handle id.
        """
        key = self.identity(path)

        async def make() -> None:
            await self._op(self._files.create(self.resolve(path)))
            await self._keep_mode(path, mode)
            await self._changed(path)

        await self._mutate(key, make)
        return self._handles.add(Handle(path=path, key=key))

    async def mkdir(self, path: str, mode: int | None = None) -> None:
        """Create a directory.

        Args:
            path (str): mount path to create.
            mode (int | None): the mode the creator asked for, umask
                applied; None takes the mount's default.
        """
        await self._op(self._files.mkdir(self.resolve(path)))
        await self._keep_mode(path, mode)

    async def _keep_mode(self, path: str, mode: int | None) -> None:
        """Store the mode a create asked for, when it is not the one the
        backend made the entry with (a disk mount applies the daemon's
        umask), so ``open(O_CREAT, 0600)`` and ``mkdir -m`` read back as
        asked without a write per ordinary create.

        Args:
            path (str): mount path just created.
            mode (int | None): the requested mode, or None.
        """
        if mode is None:
            return
        try:
            made = await self._op(self._files.stat(self.resolve(path)))
            if posix_mode(made) & 0o7777 != mode & 0o7777:
                await self.setattr(path, mode=mode)
        except OSError as err:
            # The entry exists: a policy that refuses the stat or the chmod
            # leaves the mode it was made with rather than failing a create
            # that landed.
            logger.debug("mount: keeping the mode of %s failed: %r", path, err)

    async def readlink(self, path: str) -> str:
        """The target of a namespace link, read through the dispatcher.

        Args:
            path (str): mount path to read.

        Returns:
            str: the link target, as this mount shows it.

        Raises:
            OSError: EINVAL when the path is not a link.
        """
        target = await self._op(self._files.readlink(self.resolve(path)))
        return self.shown_target(path, target)

    async def symlink(self, target: str, source: str) -> None:
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

        """
        stored = self.resolve(source) if source.startswith("/") else source
        await self._op(self._files.symlink(self.resolve(target), stored))

    async def unlink(self, path: str) -> None:
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

        key = self.identity(path, follow=False)

        async def remove() -> None:
            named = self._named(path)
            row = await self._hold(path, named)
            await self._op(self._files.unlink(self.resolve(path)))
            for ctx in named:
                ctx.detached = row
            await self._changed(path, rehydrate=False)

        await self._removing([path], lambda: self._mutate(key, remove))

    async def rename(self, old: str, new: str) -> None:
        """Rename an entry, carrying the handles open under it along.

        The facade is where a cross-mount pair is refused with EXDEV,
        which is what makes ``mv`` between two backends fall back to
        copy+unlink.

        Args:
            old (str): mount path of the entry.
            new (str): mount path it moves to.
        """
        source, target = self.resolve(old), self.resolve(new)
        moved = self.identity(old, follow=False)
        keys = [moved, self.identity(new, follow=False)]

        async def replace() -> None:
            replaced = [c for c in self._named(new) if c.key != moved]
            row = await self._hold(new, replaced)
            await self._op(self._files.rename(source, target))
            for ctx in replaced:
                ctx.detached = row
            for ctx in self._handles.values():
                if ctx.detached is not None:
                    continue
                if ctx.key == source or ctx.key.startswith(source + "/"):
                    ctx.key = target + ctx.key[len(source) :]
                    ctx.path = ctx.key[len(self._root) :]
            await self._changed(old, rehydrate=False)
            await self._changed(new, rehydrate=False)

        await self._removing(
            [old, new],
            lambda: self._queue_all(self._pending, keys, replace),
        )

    async def rmdir(self, path: str) -> None:
        await self._op(self._files.rmdir(self.resolve(path)))

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

    async def setattr(
        self,
        path: str,
        mode: int | None = None,
        uid: int | None = None,
        gid: int | None = None,
        atime: int | None = None,
        mtime: int | None = None,
        follow: bool = False,
    ) -> None:
        """Store metadata through the dispatcher.

        The backend keeps what it can and the namespace overlay the rest,
        so a chmod, chown or ``touch -d`` through the mount is what
        ``stat`` in a shell reads back, on a backend with no permission
        bits or settable times of its own too. The kernel has already
        resolved any link the call follows, so a kernel mount names the
        entry to change, a link itself for ``chown -h``; SFTP's setstat
        asks to follow one.

        Args:
            path (str): mount path to change.
            mode (int | None): permission bits; None leaves them.
            uid (int | None): owner id; None leaves it.
            gid (int | None): group id; None leaves it.
            atime (int | None): access time, epoch nanoseconds; None
                leaves it.
            mtime (int | None): modification time, epoch nanoseconds;
                None leaves it.
            follow (bool): change a trailing link's target, not the link.
        """
        key = self.identity(path, follow=follow)
        timed = atime is not None or mtime is not None

        async def run() -> None:
            # cp -p sets times on a file it still holds open: its buffered
            # writes land first, or they would stamp over them.
            if timed:
                await self._land_buffered(key)
            await self._op(
                self._files.setattr(
                    self.resolve(path),
                    mode=None if mode is None else mode & 0o7777,
                    uid=uid,
                    gid=gid,
                    atime=None if atime is None else ns_to_iso(atime),
                    mtime=None if mtime is None else ns_to_iso(mtime),
                    nofollow=not follow,
                )
            )

        await (self._mutate(key, run) if timed else run())

    async def setxattr(
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
        await self._op(
            self._files.setxattr(
                self.resolve(path),
                name,
                bytes(value),
                create=create,
                replace=replace,
            )
        )

    async def getxattr(self, path: str, name: str) -> bytes:
        """Read an extended attribute, the backend's own facts included.

        Args:
            path (str): mount path the attribute belongs to.
            name (str): attribute name.

        Returns:
            bytes: the stored payload.

        Raises:
            OSError: ENOATTR/ENODATA when the attribute is not set.
        """
        return bytes(
            await self._op(self._files.getxattr(self.resolve(path), name))
        )

    async def listxattr(self, path: str) -> list[str]:
        return list(await self._op(self._files.listxattr(self.resolve(path))))

    async def removexattr(self, path: str, name: str) -> None:
        await self._op(self._files.removexattr(self.resolve(path), name))

    async def _persist_buffered(self, ctx: Handle) -> None:
        """Persist a handle's buffered writes.

        The buffer is detached before the await so a write arriving
        meanwhile is not lost to the clear, and the runs that did not land
        are restored ahead of those later writes when persistence fails,
        so the acknowledged bytes stay for the handle's own flush to retry.

        Args:
            ctx (Handle): the handle whose buffer to land.
        """
        if not ctx.write_buf or ctx.detached is not None:
            # A detached handle keeps what it wrote, as writes to an
            # unlinked file stay with it: there is no name to land them on.
            return
        runs = write_runs(ctx.write_buf)
        ctx.write_buf = []
        try:
            await self._apply_writes(ctx.path, runs)
        except BaseException:
            ctx.write_buf = [*runs, *ctx.write_buf]
            raise

    def _named(self, path: str) -> list[Handle]:
        """The handles open on the entry at ``path`` itself.

        Args:
            path (str): mount path of the entry.
        """
        return self._open_on(self.identity(path, follow=False))

    def _open_on(self, key: str) -> list[Handle]:
        """The handles open on the file ``key`` names. A detached handle is
        on a file with no name left, whatever its key says.

        Args:
            key (str): the file identity.
        """
        return [
            ctx
            for ctx in self._handles.values()
            if ctx.key == key and ctx.detached is None
        ]

    async def _land_buffered(self, key: str) -> None:
        """Land the buffered writes of every handle open on ``key``.

        Args:
            key (str): the file identity.
        """
        for ctx in self._open_on(key):
            await self._persist_buffered(ctx)

    async def flush(self, path: str, fh: int | None) -> None:
        """Merge a handle's buffered writes and persist them.

        Args:
            path (str): mount path being flushed.
            fh (int | None): the handle whose buffer to drain.
        """
        ctx = self._handles.get(fh) if fh is not None else None
        if ctx is None:
            return
        # Queued with nothing buffered too: a flush still landing has taken
        # the buffer, and this one waits for it and retries what it puts
        # back, rather than reporting the file settled.
        key = ctx.key

        async def land() -> bool:
            # A rename that moved the handle while this waited put its file
            # in another queue: it lands from that one instead.
            if ctx.key != key:
                return False
            await self._persist_buffered(ctx)
            return True

        while not await self._mutate(key, land):
            key = ctx.key

    async def open(self, path: str, flags: int = 0) -> int:
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
        while (removal := self._removal_of(path)) is not None:
            await asyncio.shield(removal)
        keys = {self.identity(path, follow=False), self.identity(path)}
        out: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        for key in keys:
            self._opening.setdefault(key, set()).add(out)
        try:
            return await self._open_path(path, flags)
        finally:
            out.set_result(None)
            for key in keys:
                self._opening[key].discard(out)
                if not self._opening[key]:
                    del self._opening[key]

    async def _open_path(self, path: str, flags: int) -> int:
        """The open itself, which a removal of its name waits for.

        Args:
            path (str): mount path to open.
            flags (int): the open(2) flags the kernel passed.
        """
        s = await self._op(self._files.stat(self.resolve(path)))
        ctx = Handle(
            path=path,
            key=self.identity(path),
            live=s.extra.get(LIVE_KEY) is True,
        )
        if s.type == FileType.DIRECTORY:
            return self._handles.add(ctx)
        if flags & os.O_TRUNC:
            # libfuse 3 sends no SETATTR ahead of an O_TRUNC open (atomic
            # O_TRUNC), so the flag is the whole truncation.
            await self.truncate(path, 0)
        if ctx.live:
            return self._handles.add(ctx)
        if s.size is None:
            # A file an API mount cannot size is read whole now, after an
            # O_TRUNC too, so a renderer that gives an empty file a body is
            # honored; a caching mount keeps the bytes for the next stat.
            ctx.data = await asyncio.shield(self._hydrate(path))
        elif s.size > READ_CHUNK and not flags & os.O_TRUNC:
            # Read a chunk at a time: a `head` must not move the file.
            ctx.chunked = ChunkedHandle(path=path, size=s.size)
        return self._handles.add(ctx)

    def _removal_of(self, path: str) -> asyncio.Future[None] | None:
        """A removal of ``path`` still running. One is keyed by the name it
        takes, so an open through a link meets the link's removal and then
        its target's.

        Args:
            path (str): mount path being opened.
        """
        for follow in (False, True):
            removal = self._removals.get(self.identity(path, follow=follow))
            if removal is not None:
                return removal
        return None

    async def _read_chunk(
        self, ctx: Handle, chunked: ChunkedHandle, offset: int, size: int
    ) -> bytes:
        """Read through a chunked handle, fetching the chunk it lacks.

        The fetch reads the handle's path as it is then (a rename moves
        it). A file changed while the fetch was out keeps nothing, so the
        next read fetches the new bytes.

        Args:
            ctx (Handle): the handle being read.
            chunked (ChunkedHandle): its chunk window.
            offset (int): byte offset to read at.
            size (int): byte budget.
        """
        asked = chunked.missing(offset, size)
        if asked is None:
            return chunked.peek(offset, size)
        generation = chunked.generation
        data = await self._op(
            self._files.read(self.resolve(ctx.path), offset, asked)
        )
        if chunked.generation != generation:
            return data[:size]
        chunked.keep(offset, data, asked)
        return chunked.peek(offset, size)

    def _hydrate(self, path: str) -> asyncio.Future[bytes | None]:
        """Read a size-unknown file whole for the handle opening it.

        Resolves to None when the read fails for any reason: open() stays
        permissive and the read() that follows surfaces the error. This
        matters most after an O_TRUNC, whose truncation has already
        committed by the time this runs: failing the open then would erase
        the old body and refuse the replacement. Opens of one file while
        a read is out share it.

        Args:
            path (str): mount path being opened.
        """
        key = self.identity(path)
        inflight = self._hydrations.get(key)
        if inflight is not None:
            return inflight

        async def fetch() -> bytes | None:
            try:
                while True:
                    gen = self._hydration_gen.get(key, 0)
                    data = await self._op(self._files.read(self.resolve(path)))
                    # The file changed while this read was out: what came
                    # back is stale, so read again rather than hand it over.
                    if self._hydration_gen.get(key, 0) != gen:
                        continue
                    return data
            except Exception as err:
                logger.debug(
                    "fuse: hydration read of %s failed, deferring to "
                    "read(): %r",
                    path,
                    err,
                )
                return None
            finally:
                self._hydrations.pop(key, None)
                self._hydration_gen.pop(key, None)

        task = asyncio.ensure_future(fetch())
        self._hydrations[key] = task
        return task

    async def _hold(self, path: str, named: list[Handle]) -> FileStat:
        """Keep what the handles open on ``path`` need once it goes, and
        return the row they stat by from then on.

        POSIX keeps an open descriptor on the file it had, so an unlink or
        a rename onto it must not leave a handle reading or stat'ing the
        file at that name next. A handle holding no bytes yet (never read,
        or chunked and holding one chunk) gets them all from one read every
        such handle shares; it runs under ``_removing`` and the file's
        ``_pending`` chain, so no handle opens on the file and no write
        lands on it meanwhile. The handles are matched by the entry itself,
        so removing a link holds nothing: it takes the link, never its
        target's bytes. A stat or a read that fails (a policy may allow the
        removal and refuse either) leaves a bare row or the handles as they
        are, each on its own, rather than refusing a mutation the caller is
        allowed.

        Args:
            path (str): mount path about to be removed or replaced.
            named (list[Handle]): the handles open on it.

        Returns:
            FileStat: the file's row, or a bare one when it could not be
                read.
        """
        bare = FileStat(name=path.rsplit("/", 1)[-1], type=FileType.FILE)
        if not named:
            return bare
        virtual = self.resolve(path)
        row = bare
        try:
            row = await self._op(self._files.stat(virtual))
        except Exception as err:
            logger.warning(
                "fuse: the row of %s before it goes failed: %r", path, err
            )
        lacking = [c for c in named if c.data is None and not c.live]
        if not lacking:
            return row
        try:
            data = await self._op(self._files.read(virtual))
        except Exception as err:
            logger.warning(
                "fuse: holding %s before it goes failed: %r", path, err
            )
            return row
        for ctx in lacking:
            ctx.data = data
            ctx.chunked = None
        return row

    async def release(self, fh: int) -> None:
        ctx = self._handles.get(fh)
        if ctx is not None:
            # The FSKit shim sends RELEASE with no FLUSH before it.
            await self.flush(ctx.path, fh)
        self._handles.pop(fh)

    def identity(self, path: str, follow: bool = True) -> str:
        """Where a mount path really points: the mount-resolved path with
        every namespace link followed, so two handles opened through a
        link and its target are recognised as the same file.

        Args:
            path (str): mount path to identify.
            follow (bool): follow a trailing link too; an op on the
                entry itself (unlink, rename, lsetattr) names the link,
                which may loop.
        """
        virtual = self.resolve(path)
        links = self._files.links
        if links is None:
            return virtual
        if follow:
            return links.follow(virtual)
        parent, _, name = virtual.rpartition("/")
        return posixpath.join(links.follow(parent or "/"), name)

    async def truncate(self, path: str, length: int) -> None:
        """Resize a file, settling every open handle on the same file.

        A write the kernel already acknowledged on another handle precedes
        this truncation in POSIX order, so it is flushed first rather than
        left queued to land over the shortened file at that handle's
        release. Handles are matched by identity, not by the path they
        were opened through, so a link alias is settled too. Hydrated
        handles are then refreshed from the resized file, so fstat and
        read through them see the settled writes and the new length
        rather than the bytes they opened on.

        Args:
            path (str): mount path to resize.
            length (int): the new byte length.
        """
        key = self.identity(path)

        async def run() -> None:
            await self._land_buffered(key)
            await self._op(self._files.truncate(self.resolve(path), length))
            await self._changed(path)

        await self._mutate(key, run)

    async def _changed(self, path: str, rehydrate: bool = True) -> None:
        """The one function every mutation of a file's bytes goes through.

        The open handles on a file are matched by its identity (the
        mount path with namespace links followed), and this is the only
        place their bytes are refreshed, so a new mutating op cannot
        forget one of them and a link alias cannot slip past. A hydration
        still in flight is outdated so it re-reads instead of handing over
        what it fetched, and hydrated handles on the file are refreshed in
        one read through the dispatcher, so fstat and read through any of
        them, including the handle that wrote, see the new bytes. A
        removal or rename passes ``rehydrate=False``: POSIX keeps an open
        descriptor on the bytes it had, and the name, not what it points
        at, is what changed. A refresh that fails is logged and
        leaves the handles unhydrated rather than failing the committed
        mutation.

        Args:
            path (str): mount path whose bytes changed.
            rehydrate (bool): refresh the handles open on the file.
        """
        key = self.identity(path, follow=rehydrate)
        if key in self._hydrations:
            self._hydration_gen[key] = self._hydration_gen.get(key, 0) + 1
        if not rehydrate:
            return
        handles = self._open_on(key)
        for ctx in handles:
            ctx.generation += 1
            if ctx.chunked is not None:
                ctx.chunked.drop()
        hydrated = [ctx for ctx in handles if ctx.data is not None]
        if not hydrated:
            return
        try:
            data = await self._op(self._files.read(self.resolve(path)))
        except Exception as err:
            # The mutation landed, so a refresh that fails must not fail
            # it; the next read through these handles fetches and reports.
            logger.warning(
                "fuse: refresh of %s after a change failed: %r", path, err
            )
            for ctx in hydrated:
                ctx.data = None
            return
        for ctx in hydrated:
            ctx.data = data
