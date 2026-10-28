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
import posixpath
import time
from collections.abc import Awaitable, Callable
from dataclasses import replace
from typing import Any, TypeVar, cast
from weakref import WeakKeyDictionary

from mirage.concurrency.limiter import owned_task
from mirage.context import reset_current_session, set_current_session
from mirage.errors import FsCondition, classify
from mirage.errors.fs import ebadf, eexist, einval, eisdir, enoent, enotdir
from mirage.errors.types import NoMountError, OperationNotSupportedError
from mirage.io.spool import MEMORY_LIMIT, ByteSlice, ByteSpool
from mirage.io.types import materialize
from mirage.mount.constants import (
    FSTAT_ROW_SECONDS,
    LISTING_CONCURRENCY,
    OWNER,
)
from mirage.mount.platform.macos import is_macos_metadata
from mirage.mount.types import Handle, MountAttrs, WriteBuf
from mirage.policy.match import skipped_at_dispatch
from mirage.runtime.handles import (
    ChunkedHandle,
    FileTable,
    overlaid,
    run_groups,
    run_stream,
    window_writes,
    write_runs,
)
from mirage.runtime.handles.constants import READ_CHUNK
from mirage.runtime.handles.mode import READ, OpenMode
from mirage.types import LIVE_KEY, FileStat, FileType, PathSpec
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
from mirage.workspace.files import Files, reader_of
from mirage.workspace.session.session import SessionState

logger = logging.getLogger(__name__)

T = TypeVar("T")

# An entry a listing's stat no longer finds went between the two.
VANISHED = (FileNotFoundError, NotADirectoryError, NoMountError)

# One cap per workspace loop, so the listings that run at once on one
# workspace share it rather than each bringing a cap of its own.
_STATS: WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = (
    WeakKeyDictionary()
)


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
        # Per file identity and view (stored or rendered): the hydration
        # read out (opens share it) and a generation a change under it
        # bumps. Per identity: the chain of mutations, the chain of
        # removals, and the opens out that a removal waits for.
        self._hydrations: dict[
            tuple[str, bool], asyncio.Future[bytes | None]
        ] = {}
        self._hydration_gen: dict[tuple[str, bool], int] = {}
        # The mounts that refused an append, which land one as a write.
        self._no_append: set[str] = set()
        # Names the files whose name went, one per removal.
        self._removed = 0
        self._pending: dict[str, asyncio.Future[None]] = {}
        self._removals: dict[str, asyncio.Future[None]] = {}
        self._opening: dict[str, set[asyncio.Future[None]]] = {}
        self._uid, self._gid = OWNER

    @property
    def files(self) -> Files:
        return self._files

    @property
    def handles(self) -> FileTable[Handle]:
        return self._handles

    @property
    def session(self) -> SessionState | None:
        return self._session

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

    async def _stat_cached(self, path: str, row: FileStat) -> FileStat:
        """Judge retained metadata through the stat policy boundary.

        Args:
            path (str): the handle's current mount path.
            row (FileStat): the metadata this stat would return.
        """
        result, _ = await self._op(
            self._files.dispatch(
                "stat",
                PathSpec.from_str_path(self.resolve(path), cwd="/"),
                retained=row,
            )
        )
        return cast(FileStat, result)

    async def _read_cached(self, path: str, data: bytes) -> bytes:
        """Judge retained bytes through the same read boundary as a fetch.

        Args:
            path (str): the handle's current mount path.
            data (bytes): the bytes this read would return.
        """
        result, _ = await self._op(
            self._files.dispatch(
                "read",
                PathSpec.from_str_path(self.resolve(path), cwd="/"),
                retained=data,
            )
        )
        return cast(bytes, result)

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
            s = await self._stat_cached(
                "/", FileStat(name="/", type=FileType.DIRECTORY)
            )
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
        if path == "/":
            return await self.root_attrs()
        # macOS Finder/Spotlight probes .DS_Store, ._*, .Spotlight-V100, etc.
        # Reject early to avoid hitting the ops layer.
        if is_macos_metadata(path.rsplit("/", 1)[-1]):
            raise enoent(path)
        s = await self._row(path, follow, ctx)
        if is_link(s):
            target = await self._op(self._files.readlink(self.resolve(path)))
            return self.attrs(s, len(self.shown_target(path, target).encode()))
        return self.attrs(s)

    async def _row(
        self,
        path: str,
        follow: bool,
        ctx: Handle | None,
        reuse: bool = False,
    ) -> FileStat:
        """The row a stat of ``path`` answers, the size an open handle
        holds and what it wrote and has not landed counted.

        Args:
            path (str): mount path to stat.
            follow (bool): report a trailing link's target.
            ctx (Handle | None): the open handle a fstat reads through.
            reuse (bool): answer by the row the handle fetched less than
                ``FSTAT_ROW_SECONDS`` ago, if nothing changed the file
                through the core since, judged without a fetch.
        """
        size = None if ctx is None or ctx.data is None else len(ctx.data)
        retained = False
        if ctx is not None and ctx.detached is not None:
            # Its name is gone: it stats by the row its file had then.
            retained = True
            s = ctx.detached
        elif (
            reuse
            and ctx is not None
            and ctx.row is not None
            and time.monotonic() - ctx.row_at < FSTAT_ROW_SECONDS
        ):
            # Judged as a stat now, as a held row is, without a fetch.
            retained = True
            s = ctx.row
        else:
            restats = 0 if ctx is None else ctx.restats
            try:
                s = await self._op(
                    self._files.stat(self.resolve(path), nofollow=not follow)
                )
            except FileNotFoundError:
                if size is None:
                    raise
                # A hide is not an unlink: held metadata still meets the walk.
                retained = True
                s = FileStat(name=path.rsplit("/", 1)[-1], type=FileType.FILE)
            else:
                if ctx is not None and ctx.restats == restats:
                    ctx.row, ctx.row_at = s, time.monotonic()
        if is_link(s):
            return s
        if is_dir(s):
            return await self._stat_cached(path, s) if retained else s
        if size is None and s.size is None:
            # A size-unknown file stats as 0 rather than be fetched on
            # every ls -l; direct_io keeps its reads whole regardless.
            size = self.held_size(path)
        key = self.identity(path, follow) if ctx is None else ctx.key
        writes = self._writes_on(key, ctx)
        if writes:
            stored = content_size(s) if size is None else size
            size = max(stored, *(o + len(d) for o, d in writes))
        if size is not None and size != s.size:
            s = s.model_copy(update={"size": size})
        # A row the stat above fetched was judged there; a held one is
        # judged here, with the size the handle answers.
        if retained:
            s = await self._stat_cached(path, s)
        return s

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

    async def stat(self, path: str, follow: bool = True) -> FileStat:
        """The row a stat of ``path`` answers, what the handles open on
        it wrote and have not landed counted, as a guest projects it into
        its own record.

        Args:
            path (str): mount path to stat.
            follow (bool): report a trailing link's target.
        """
        return await self._row(path, follow, None)

    async def fstat(self, fh: int) -> FileStat:
        """The row an open handle stats by: its file's, with the size it
        holds and what it wrote and has not landed counted, judged as a
        stat of its path. A guest projects this into its own record.

        Args:
            fh (int): the open handle.
        """
        ctx = self._open_handle(fh)
        await self._settled(ctx)
        return await self._row(ctx.path, True, ctx, reuse=True)

    def _open_handle(self, fh: int) -> Handle:
        """The handle ``fh`` names; EBADF for any other number.

        Args:
            fh (int): the handle id.
        """
        ctx = self._handles.get(fh)
        if ctx is None:
            raise ebadf(str(fh))
        return ctx

    @staticmethod
    def _end(ctx: Handle) -> int:
        """Where the file a handle holds ends: its bytes, else the length
        its open saw, and past them what it wrote.

        Args:
            ctx (Handle): the open handle.
        """
        if ctx.data is not None:
            stored = len(ctx.data)
        elif ctx.chunked is not None:
            stored = ctx.chunked.size
        else:
            stored = ctx.size
        return max([stored, *(o + len(d) for o, d in ctx.write_buf)])

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

    async def listing(
        self,
        path: str,
        names: list[str] | None = None,
        follow: bool = False,
    ) -> list[tuple[str, MountAttrs]]:
        """A directory's entries with their attributes, in one pass.

        The entries are stat'd together rather than one after another,
        with at most ``LISTING_CONCURRENCY`` stats out at once across
        every listing on the loop. A stat that fails ends the listing and
        cancels the ones still waiting. An entry that vanishes between
        the listing and its stat is left out, as ``ls`` leaves out a file
        deleted mid-listing.

        Args:
            path (str): mount path of the directory.
            names (list[str] | None): the entries to stat, in the order
                they are answered; None takes ``readdir``'s, ``.`` and
                ``..`` first.
            follow (bool): report what a link entry points at.

        Returns:
            list[tuple[str, MountAttrs]]: (name, attributes) pairs.
        """
        loop = asyncio.get_running_loop()
        slots = _STATS.get(loop)
        if slots is None:
            slots = _STATS[loop] = asyncio.Semaphore(LISTING_CONCURRENCY)

        async def entry(name: str) -> tuple[str, MountAttrs] | None:
            if name == ".":
                child = path
            elif name == "..":
                child = posixpath.dirname(path)
            else:
                child = posixpath.join(path, name)
            async with slots:
                try:
                    return name, await self.getattr(child, follow)
                except VANISHED as exc:
                    logger.debug("%s vanished while listing: %r", child, exc)
                    return None

        listed = await self.readdir(path) if names is None else names
        rows: list[tuple[str, MountAttrs] | None] = [None] * len(listed)
        todo = iter(enumerate(listed))

        async def worker() -> None:
            for index, name in todo:
                rows[index] = await entry(name)

        try:
            async with asyncio.TaskGroup() as group:
                for _ in range(min(LISTING_CONCURRENCY, len(listed))):
                    group.create_task(worker())
        except BaseExceptionGroup as failed:
            # The first refusal is the listing's answer, as it was before
            # the rest were cancelled.
            raise failed.exceptions[0]
        return [row for row in rows if row is not None]

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
            writes = self._writes_on(self.identity(path), None)
            if writes:
                laid = await window_writes(writes, offset, size)
                return await self._read_cached(
                    path, overlaid(data[offset:], offset, size, laid)
                )
            return data[offset : offset + size]
        if not ctx.mode.readable:
            raise ebadf(ctx.path)
        if ctx.lost is not None and ctx.data is None:
            raise ctx.lost
        # A flush still landing has taken the handle's buffer and not yet
        # refreshed its bytes: wait for it, so the read sees what was
        # written.
        await self._settled(ctx)
        retained = False
        # A handle that writes reads the stored bytes its writes land on;
        # one that only reads sees the rendering.
        raw = ctx.mode.writable
        if ctx.live:
            stored = await self._op(
                self._files.read(self.resolve(ctx.path), offset, size, raw)
            )
        elif ctx.chunked is not None and ctx.data is None:
            retained = ctx.chunked.holds(offset, size)
            stored = await self._read_chunk(ctx, ctx.chunked, offset, size)
        else:
            held = ctx.data
            if held is None:
                # A change landing while this read is out keeps it from
                # holding what it fetched.
                generation = ctx.generation
                held = await self._op(
                    self._files.read(self.resolve(ctx.path), raw=raw)
                )
                if ctx.generation == generation:
                    ctx.data = held
            else:
                retained = True
            stored = held[offset : offset + size]
        writes = self._writes_on(ctx.key, ctx)
        data = (
            overlaid(
                stored, offset, size, await window_writes(writes, offset, size)
            )
            if writes
            else stored
        )
        if retained or writes:
            return await self._read_cached(ctx.path, data)
        return data

    def _writes_on(self, key: str, ctx: Handle | None) -> WriteBuf:
        """What a read of the file ``key`` names sees that has not landed:
        every handle's writes on it, as write(2) is seen by every reader at
        once. ``_supersede`` keeps them apart, so they lay over the stored
        bytes in any order; an appending handle's are its own, since they
        land at the end the file has then, and the reader's own go last.

        Args:
            key (str): the file identity.
            ctx (Handle | None): the handle reading; None reads by path.
        """
        out: WriteBuf = []
        for other in self._open_on(key):
            if other is not ctx and not other.mode.append:
                out.extend(other.write_buf)
        if ctx is not None:
            out.extend(ctx.write_buf)
        return out

    async def _apply_writes(
        self,
        path: str,
        runs: list[tuple[int, bytes]],
        append: bool = False,
    ) -> None:
        """Land write runs on the mount, one pwrite each, in order.

        A pwrite keeps every stored byte the handle did not write, so
        nothing is read through the dispatcher first: a session that may
        write a file and not read it writes through FUSE, as through a
        write-only descriptor. An appending handle's runs land as appends
        instead, at the end the file has then, so what another writer
        appended meanwhile stays before them, as O_APPEND keeps it. The
        runs that landed leave ``runs`` in one step, so after a failure
        ``runs`` holds only what did not land and a retry never replays
        a run over bytes another writer has since put there. A run that
        fails still invalidates what the core holds, since the runs
        before it have landed.

        Args:
            path (str): mount path being written.
            runs (list[tuple[int, bytes]]): (offset, payload) runs; the
                landed ones are removed.
            append (bool): the runs are an appending handle's.
        """
        target = self.resolve(path)
        landed = 0
        try:
            for offset, data in runs:
                if append:
                    await self._append(target, data)
                else:
                    await self._op(self._files.pwrite(target, data, offset))
                landed += 1
        finally:
            del runs[:landed]
            await self._changed(path)

    async def _append(self, target: str, data: bytes | WriteBuf) -> None:
        """Extend a file by ``data`` at the end it has now. A mount with
        no append (S3) takes a write of the whole file, read fresh from
        the backend rather than from a copy, so a write another action
        made since stays; a mount that declined once is remembered.

        Args:
            target (str): the workspace path.
            data (bytes | WriteBuf): the bytes to add, or a group of
                buffered writes some of which wait in a spool, streamed.
        """
        mount = self._files.mount_of(target) or target
        if mount not in self._no_append:
            try:
                await self._op(
                    self._files.append(
                        target,
                        data if isinstance(data, bytes) else run_stream(data),
                    )
                )
                return
            except OperationNotSupportedError:
                self._no_append.add(mount)
        if not isinstance(data, bytes):
            data = await materialize(run_stream(data))
        try:
            base, _ = await self._op(
                self._files.dispatch(
                    "read",
                    PathSpec.from_str_path(target, cwd="/"),
                    filetype=None,
                    direct=True,
                )
            )
        except FileNotFoundError:
            base = b""
        await self._op(self._files.write(target, bytes(base) + data))

    async def write(
        self, path: str, data: bytes, offset: int, fh: int | None
    ) -> int:
        """Write bytes at an offset, buffering when a handle is open. An
        appending handle writes at the end it holds, whatever the offset.

        Args:
            path (str): mount path to write.
            data (bytes): payload.
            offset (int): byte offset to write at.
            fh (int | None): open handle; buffers until flush when present.

        Returns:
            int: number of bytes accepted.

        Raises:
            OSError: EBADF through a handle opened only to read.
        """
        ctx = self._handles.get(fh) if fh is not None else None
        if ctx is not None:
            if not ctx.mode.writable:
                raise ebadf(ctx.path)
            if ctx.mode.append:
                offset = self._end(ctx)
            self._supersede(ctx.key, offset, len(data), ctx)
            await self._buffer(ctx, offset, data)
            return len(data)
        key = self.identity(path)
        self._supersede(key, offset, len(data), None)
        await self._mutate(
            key, lambda: self._apply_writes(path, [(offset, data)])
        )
        return len(data)

    @staticmethod
    async def _buffer(ctx: Handle, offset: int, data: bytes) -> None:
        """Keep a write on its handle: one that starts inside the last run
        or right at its end folds into it, so a stream of writes stays
        one run; any other starts a run of its own, laid over the earlier
        ones in order. Past ``MEMORY_LIMIT`` held in memory, the handle's
        runs move to its spool, and a stream goes on at the spool's end.
        A spool append starts before this yields, so it is queued in the
        spool ahead of any read of the window it publishes.

        Args:
            ctx (Handle): the handle writing.
            offset (int): where the write starts.
            data (bytes): the payload.
        """
        if not data:
            return
        if ctx.write_buf:
            start, last = ctx.write_buf[-1]
            end = start + len(last)
            if isinstance(last, bytearray) and start <= offset <= end:
                last[offset - start : offset - start + len(data)] = data
                await MountCore._spill(ctx)
                return
            if (
                isinstance(last, ByteSlice)
                and offset == end
                and last.source is ctx.spool
                and last.offset + len(last) == ctx.spooled
            ):
                ctx.write_buf[-1] = (
                    start,
                    ByteSlice(last.source, last.offset, len(last) + len(data)),
                )
                ctx.spooled += len(data)
                await asyncio.shield(owned_task(last.source.append(data)))
                return
        ctx.write_buf.append((offset, bytearray(data)))
        await MountCore._spill(ctx)

    @staticmethod
    async def _spill(ctx: Handle) -> None:
        """Move a handle's runs held in memory to its spool once they hold
        more than ``MEMORY_LIMIT``. Each takes its place in the spool
        before the spool has its bytes, in one append, so a write or a
        read meanwhile finds the run where it will be.

        Args:
            ctx (Handle): the handle writing.
        """
        held = [
            (index, run)
            for index, (_, run) in enumerate(ctx.write_buf)
            if isinstance(run, bytearray)
        ]
        if sum(len(run) for _, run in held) <= MEMORY_LIMIT:
            return
        if ctx.spool is None:
            ctx.spool, ctx.spooled = ByteSpool(), 0
        for index, run in held:
            at = ctx.write_buf[index][0]
            ctx.write_buf[index] = (
                at,
                ByteSlice(ctx.spool, ctx.spooled, len(run)),
            )
            ctx.spooled += len(run)
        await asyncio.shield(
            owned_task(ctx.spool.append(b"".join(run for _, run in held)))
        )

    def _supersede(
        self, key: str, offset: int, size: int, ctx: Handle | None
    ) -> None:
        """Cut a new write's range out of what the file's other handles
        hold: their bytes there are older, and the new write replaces them.

        No two handles on a file then hold the same bytes, so whichever
        flush, release or sync lands first, the file ends as its writes
        were made. Nothing lands here, so a write never waits on one.

        Args:
            key (str): the file identity.
            offset (int): where the new write starts.
            size (int): its length.
            ctx (Handle | None): the handle making it, None for a direct
                write.
        """
        if ctx is not None and ctx.mode.append:
            # Its bytes land at the end the file has then, not here.
            return
        end = offset + size
        for other in self._open_on(key):
            if other is ctx or other.mode.append:
                continue
            kept: WriteBuf = []
            for at, run in other.write_buf:
                if at >= end or at + len(run) <= offset:
                    kept.append((at, run))
                    continue
                if at < offset:
                    kept.append((at, run[: offset - at]))
                if at + len(run) > end:
                    kept.append((end, run[end - at :]))
            other.write_buf = kept

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
        await self._make(path, mode)
        return self._handles.add(
            Handle(
                path=path,
                key=key,
                mode=replace(READ, writable=True, create=True),
            )
        )

    async def _make(self, path: str, mode: int | None) -> None:
        """Create an empty file in the file's turn.

        Args:
            path (str): mount path to create.
            mode (int | None): the requested mode, or None.
        """

        async def make() -> None:
            await self._op(self._files.create(self.resolve(path)))
            await self._keep_mode(path, mode)
            await self._changed(path)

        await self._mutate(self.identity(path), make)

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
            self._detach(named, row)
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
            # Both ends as the links above them lead in this turn, right
            # before the move: a link the move takes along no longer leads
            # there after it.
            start = self.identity(old, follow=False)
            landing = self.identity(new, follow=False)
            await self._op(self._files.rename(source, target))
            self._detach(replaced, row)
            for ctx in self._handles.values():
                if ctx.detached is not None:
                    continue
                if ctx.key == start or ctx.key.startswith(start + "/"):
                    rest = ctx.key[len(start) :]
                    ctx.key = landing + rest
                    ctx.path = self._mount_path(ctx.key, new + rest)
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
            self._restat(key)

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
        if not ctx.write_buf:
            return
        if ctx.detached is not None:
            await self._land_held(ctx, ctx.detached)
            return
        held = [
            (at, run)
            for at, run in ctx.write_buf
            if isinstance(run, bytearray)
        ]
        if len(held) < len(ctx.write_buf):
            groups = run_groups(ctx.write_buf)
            ctx.write_buf = []
            try:
                await self._land_spooled(ctx, groups)
            except BaseException:
                ctx.write_buf = [
                    *(write for group in groups for write in group),
                    *ctx.write_buf,
                ]
                raise
            await self._free_spool(ctx)
            return
        runs = write_runs(held)
        ctx.write_buf = []
        try:
            await self._apply_writes(ctx.path, runs, ctx.mode.append)
        except BaseException:
            ctx.write_buf = [
                *((at, bytearray(run)) for at, run in runs),
                *ctx.write_buf,
            ]
            raise

    async def _land_spooled(self, ctx: Handle, groups: list[WriteBuf]) -> None:
        """Land a buffer whose writes wait in its spool, each group of
        writes ``write_runs`` would fold into one run as a stream, in
        order. A group from the file's start that reaches its stored end
        leaves nothing of what is stored, so it lands as a write of the
        whole file, which a store with no pwrite (S3) takes in parts
        rather than reading the file back first; any other lands as one
        pwrite of its bytes, and an appending handle's as appends. The
        groups that landed leave ``groups``, as ``_apply_writes`` drops
        its runs.

        Args:
            ctx (Handle): the handle whose buffer lands.
            groups (list[WriteBuf]): its ``run_groups``; the landed ones
                are removed.
        """
        target = self.resolve(ctx.path)
        landed = 0
        try:
            for group in groups:
                start = group[0][0]
                end = max(at + len(run) for at, run in group)
                if ctx.mode.append:
                    await self._append(target, group)
                elif start == 0 and await self._ends_by(ctx.path, end):
                    # TODO(MIRAGE-34): hand a whole spool over, not a second copy.
                    await self._op(
                        self._files.write(target, run_stream(group))
                    )
                else:
                    # TODO(MIRAGE-35): stream this pwrite rather than hold the group.
                    data = await materialize(run_stream(group))
                    await self._op(self._files.pwrite(target, data, start))
                landed += 1
        finally:
            del groups[:landed]
            await self._changed(ctx.path)

    async def _ends_by(self, path: str, end: int) -> bool:
        """Whether the stored file at ``path`` is missing or ends at or
        before ``end``, by a fresh stat, which waits out a write already
        landing on the path, so an append under way is counted.

        Args:
            path (str): mount path of the file.
            end (int): the offset it may reach.
        """
        try:
            row = await self._op(
                self._files.stat(self.resolve(path), fresh=True)
            )
        except FileNotFoundError:
            return True
        return row.size is not None and row.size <= end

    @staticmethod
    async def _free_spool(ctx: Handle) -> None:
        """Close a handle's spool once none of its writes wait there.

        Args:
            ctx (Handle): the handle.
        """
        spool = ctx.spool
        if spool is None or any(
            isinstance(run, ByteSlice) for _, run in ctx.write_buf
        ):
            return
        ctx.spool = None
        await spool.close()

    async def _land_held(self, ctx: Handle, row: FileStat) -> None:
        """Land a handle's writes on a file whose name went: on the bytes
        it holds, which every handle open on that file reads, as writes
        to an unlinked file stay with it. A handle reading a rendering
        the stored bytes differ from keeps its own. The writes and their
        spool leave the handle before the spool is read, so a write
        arriving meanwhile stays for the next landing.

        Args:
            ctx (Handle): a detached handle with writes buffered.
            row (FileStat): the row it stats by.
        """
        held = ctx.data or b""
        end = self._end(ctx)
        writes, ctx.write_buf = ctx.write_buf, []
        spool, ctx.spool = ctx.spool, None
        try:
            data = overlaid(held, 0, end, await window_writes(writes, 0, end))
        except BaseException:
            ctx.write_buf = [*writes, *ctx.write_buf]
            if ctx.spool is None:
                ctx.spool = spool
            raise
        if spool is not None:
            await spool.close()
        landed = row.model_copy(update={"size": len(data)})
        for other in self._open_on(ctx.key):
            if other is ctx or other.data is held:
                other.data = data
                other.detached = landed

    def _named(self, path: str) -> list[Handle]:
        """The handles open on the entry at ``path`` itself.

        Args:
            path (str): mount path of the entry.
        """
        return self._open_on(self.identity(path, follow=False))

    def _open_on(self, key: str) -> list[Handle]:
        """The handles open on the file ``key`` names. The handles left on
        a file whose name went share a key of their own (``_detach``), so
        no path names them.

        Args:
            key (str): the file identity.
        """
        return [ctx for ctx in self._handles.values() if ctx.key == key]

    def _detach(self, named: list[Handle], row: FileStat) -> None:
        """Leave the handles open on a name that went on the file it had:
        they stat by its row from then on, and share a key no path gives,
        so a write through one reaches the others and nothing that opens
        the name later.

        Args:
            named (list[Handle]): the handles open on the name.
            row (FileStat): the file's row before it went.
        """
        self._removed += 1
        key = f"\0{self._removed}"
        for ctx in named:
            ctx.detached = row
            ctx.key = key

    async def land(self, path: str, follow: bool = True) -> None:
        """Land what every handle open on ``path`` wrote, in the file's
        turn, as a change of its times by path must come after.

        Args:
            path (str): mount path whose open handles land.
            follow (bool): the change follows a link at ``path``.
        """
        key = self.identity(path, follow)
        await self._mutate(key, lambda: self._land_buffered(key))

    async def restat(self, path: str, follow: bool = True) -> None:
        """Have the handles open on ``path`` stat it afresh, after a
        change by path made past the core (a runtime's setattr or
        whole-file write), so their next fstat agrees with stat.

        Args:
            path (str): mount path that changed.
            follow (bool): the change followed a link at ``path``.
        """
        self._restat(self.identity(path, follow))

    def _restat(self, key: str) -> None:
        """Drop the stat rows the handles open on ``key`` keep, and
        outdate a stat of theirs still out.

        Args:
            key (str): the file identity.
        """
        for ctx in self._open_on(key):
            ctx.row = None
            ctx.restats += 1

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
        if ctx is not None:
            await self._settle(ctx)

    async def sync(self) -> None:
        """Land what every open handle holds, as sync(2) does.

        For a client whose close(2) returns before it releases the handle
        (sshfs). A landing that fails is logged, and its bytes stay on the
        handle for its own flush to retry and report.
        """
        for ctx in list(self._handles.values()):
            try:
                await self._settle(ctx)
            except Exception as err:
                logger.warning("fuse: landing %s failed: %r", ctx.path, err)

    async def _settle(self, ctx: Handle) -> None:
        """Land a handle's buffered writes in its file's turn.

        Args:
            ctx (Handle): the handle whose buffer to drain.
        """
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

    async def open(
        self, path: str, mode: OpenMode = READ, perm: int | None = None
    ) -> int:
        """Open a path, the open's effect landing before any byte moves.

        One rule for every entry point, however it spells the open
        (open(2) flags, SFTP pflags, an fopen mode, preview1 oflags): an
        exclusive create refuses what exists, a dangling link or a listed
        directory included; a directory refuses a mode that would write
        it; a missing path is created when the mode creates and refused
        when it does not; a truncating mode empties what exists, which
        CPython's ``open('w')`` leaves behind even when nothing is
        written; and a mode that writes is admitted against the file's
        write rules before its first write. A file an API mount cannot
        size is then read whole.

        Args:
            path (str): mount path to open.
            mode (OpenMode): what the open asked for.
            perm (int | None): the mode bits a create gives the file,
                umask applied; None takes the mount's default.

        Returns:
            int: the new handle id.

        Raises:
            FileExistsError: an exclusive create found the path.
            IsADirectoryError: a mode that writes named a directory.
            FileNotFoundError: no such entry, and the mode does not
                create.
        """
        while (removal := self._removal_of(path)) is not None:
            await asyncio.shield(removal)
        keys = {self.identity(path, follow=False), self.identity(path)}
        out: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        for key in keys:
            self._opening.setdefault(key, set()).add(out)
        try:
            return await self._open_path(path, mode, perm)
        finally:
            out.set_result(None)
            for key in keys:
                self._opening[key].discard(out)
                if not self._opening[key]:
                    del self._opening[key]

    async def _open_path(
        self, path: str, mode: OpenMode, perm: int | None
    ) -> int:
        """The open itself, which a removal of its name waits for.

        Args:
            path (str): mount path to open.
            mode (OpenMode): what the open asked for.
            perm (int | None): the mode bits a create gives the file.
        """
        if path.endswith("/") and path != "/":
            leaf = await self._row_or_none(path.rstrip("/"))
            if leaf is not None and not is_dir(leaf):
                raise enotdir(path)
            if leaf is None and mode.create:
                raise eisdir(path)
        # An exclusive create follows no link (O_CREAT|O_EXCL), so a
        # dangling one is a name that is there. A path with no row may
        # still be a directory the mount lists, and a create there would
        # put a file at a directory's name.
        s = await self._row_or_none(path, nofollow=mode.exclusive)
        listed = is_dir(s) if s is not None else await self._listed(path)
        if mode.exclusive and (s is not None or listed):
            raise eexist(path)
        key = self.identity(path)
        if listed:
            if mode.writable or mode.create or not mode.directory:
                raise eisdir(path)
            return self._handles.add(Handle(path=path, key=key, mode=mode))
        # The handle reads and writes the file the open reached, not the
        # one a link at ``path`` names later.
        at = self._mount_path(key, path)
        emptied = s is None or mode.truncate
        if s is None:
            if not mode.create:
                raise enoent(path)
            await self._make(path, perm)
        elif mode.truncate:
            await self._empty(path)
        elif mode.writable:
            await self._op(
                self._files.dispatch(
                    "write",
                    PathSpec.from_str_path(self.resolve(path), cwd="/"),
                    admit_only=True,
                )
            )
        ctx = Handle(
            path=at,
            key=key,
            mode=mode,
            live=s is not None and s.extra.get(LIVE_KEY) is True,
            size=0 if s is None or mode.truncate else content_size(s),
        )
        if ctx.live or s is None:
            return self._handles.add(ctx)
        if not emptied:
            ctx.row, ctx.row_at = s, time.monotonic()
        if s.size is None:
            # A file an API mount cannot size is read whole now, after an
            # O_TRUNC too, so a renderer that gives an empty file a body is
            # honored; a caching mount keeps the bytes for the next stat.
            ctx.data = await asyncio.shield(self._hydrate(at, mode.writable))
        elif s.size > READ_CHUNK and not emptied:
            # Read a chunk at a time: a `head` must not move the file.
            ctx.chunked = ChunkedHandle(path=at, size=s.size)
        return self._handles.add(ctx)

    async def _row_or_none(
        self, path: str, nofollow: bool = False
    ) -> FileStat | None:
        """The path's row, or None when the mount says it is not there.

        Args:
            path (str): mount path to stat.
            nofollow (bool): report a trailing link itself.
        """
        try:
            return await self._op(
                self._files.stat(self.resolve(path), nofollow=nofollow)
            )
        except FileNotFoundError:
            return None

    async def _listed(self, path: str) -> bool:
        """Whether a path with no row is a directory the mount only
        implies (the root above a nested mount), which it lists.

        Args:
            path (str): mount path with no row.
        """
        try:
            await self._op(self._files.readdir(self.resolve(path)))
        except (FileNotFoundError, NotADirectoryError):
            return False
        return True

    async def _empty(self, path: str) -> None:
        """Empty a file an open truncates. A mount with no truncate (hf
        buckets, databricks volumes) still empties it through an empty
        create, which is the effect the open asked for.

        Args:
            path (str): mount path to empty.
        """
        try:
            # libfuse 3 sends no SETATTR ahead of an O_TRUNC open (atomic
            # O_TRUNC), so the flag is the whole truncation.
            await self.truncate(path, 0)
        except Exception as exc:
            if classify(exc) is not FsCondition.ENOTSUP:
                raise
            await self._make(path, None)

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
            self._files.read(
                self.resolve(ctx.path), offset, asked, ctx.mode.writable
            )
        )
        if chunked.generation != generation:
            return data[:size]
        chunked.keep(offset, data, asked)
        return chunked.peek(offset, size)

    def _hydrate(self, path: str, raw: bool) -> asyncio.Future[bytes | None]:
        """Read a size-unknown file whole for the handle opening it.

        Resolves to None when the read fails for any reason: open() stays
        permissive and the read() that follows surfaces the error. This
        matters most after an O_TRUNC, whose truncation has already
        committed by the time this runs: failing the open then would erase
        the old body and refuse the replacement. Opens of one view of one
        file while a read is out share it.

        Args:
            path (str): mount path being opened.
            raw (bool): the stored bytes, for a handle that writes,
                rather than the rendering.
        """
        key = (self.identity(path), raw)
        inflight = self._hydrations.get(key)
        if inflight is not None:
            return inflight

        async def fetch() -> bytes | None:
            try:
                while True:
                    gen = self._hydration_gen.get(key, 0)
                    data = await self._op(
                        self._files.read(self.resolve(path), raw=raw)
                    )
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
        such handle of its view shares, the stored bytes for one that
        writes and the rendering for one that only reads, and handles whose
        views agree hold one copy, which a write through any of them then
        reaches (``_land_held``); it runs under ``_removing`` and the file's
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
        for raw in (True, False):
            lacking = [
                c
                for c in named
                if c.data is None and not c.live and c.mode.writable == raw
            ]
            if not lacking:
                continue
            try:
                data = await self._op(self._files.read(virtual, raw=raw))
            except Exception as err:
                logger.warning(
                    "fuse: holding %s before it goes failed: %r", path, err
                )
                for ctx in lacking:
                    ctx.lost = err
                continue
            for ctx in lacking:
                ctx.data = data
                ctx.chunked = None
        copies: list[bytes] = []
        for ctx in named:
            if ctx.data is None:
                continue
            same = next((c for c in copies if c == ctx.data), None)
            if same is None:
                copies.append(ctx.data)
            else:
                ctx.data = same
        return row

    async def release(self, fh: int) -> None:
        """Land a handle's buffered writes and let it go.

        The handle goes even when the landing fails, as close(2) releases
        its descriptor: no adapter retries a release, so a kept handle
        would never close. The failure still reaches the caller.

        Args:
            fh (int): the handle to release.
        """
        ctx = self._handles.get(fh)
        try:
            if ctx is not None:
                # The FSKit shim sends RELEASE with no FLUSH before it.
                await self.flush(ctx.path, fh)
        finally:
            self._handles.pop(fh)
            if ctx is not None and ctx.spool is not None:
                await ctx.spool.close()

    def _mount_path(self, key: str, spelled: str) -> str:
        """The mount path the file ``key`` names, or ``spelled`` where it
        lies outside the mount's root.

        Args:
            key (str): the file's identity.
            spelled (str): the mount path to fall back on.
        """
        if key.startswith(self._root + "/"):
            return key[len(self._root) :]
        return spelled

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
        reader = reader_of(self._files)
        # Judged as the bound session judges every op (``_op``): outside
        # it the facade's session is the default one, whose profile may
        # hide a link this session's handles were opened through.
        token = (
            None
            if self._session is None
            else set_current_session(self._session)
        )
        try:
            if follow:
                return posixpath.normpath(reader.follow(virtual))
            return reader.follow_parent(virtual)
        finally:
            if token is not None:
                reset_current_session(token)

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
        self._restat(key)
        for view in ((key, True), (key, False)):
            if view in self._hydrations:
                self._hydration_gen[view] = (
                    self._hydration_gen.get(view, 0) + 1
                )
        if not rehydrate:
            return
        handles = self._open_on(key)
        for ctx in handles:
            ctx.generation += 1
            if ctx.chunked is not None:
                ctx.chunked.drop()
        for raw in (True, False):
            hydrated = [
                ctx
                for ctx in handles
                if ctx.data is not None and ctx.mode.writable == raw
            ]
            if not hydrated:
                continue
            try:
                data = await self._op(
                    self._files.read(self.resolve(path), raw=raw)
                )
            except Exception as err:
                # The mutation landed, so a refresh that fails must not
                # fail it; the next read through these handles fetches
                # and reports.
                logger.warning(
                    "fuse: refresh of %s after a change failed: %r", path, err
                )
                for ctx in hydrated:
                    ctx.data = None
                continue
            for ctx in hydrated:
                ctx.data = data
        # An appending handle holding no bytes writes at the length its
        # open saw; the file has another one now.
        sized = [
            ctx for ctx in handles if ctx.mode.append and ctx.data is None
        ]
        if not sized:
            return
        try:
            s = await self._op(self._files.stat(self.resolve(path)))
        except Exception as err:
            logger.warning(
                "fuse: the length of %s after a change failed: %r", path, err
            )
            return
        for ctx in sized:
            ctx.size = content_size(s)
            if ctx.chunked is not None:
                ctx.chunked.size = content_size(s)

    async def ftruncate(self, fh: int, length: int) -> None:
        """Resize the file an open handle is on: through its name, or, on
        a file whose name went, the bytes its handles hold.

        Args:
            fh (int): the open handle.
            length (int): the new byte length.

        Raises:
            OSError: EBADF through a handle opened only to read, EINVAL
                for a negative length.
        """
        ctx = self._open_handle(fh)
        if not ctx.mode.writable:
            raise ebadf(ctx.path)
        if length < 0:
            raise einval(ctx.path)
        row = ctx.detached
        if row is None:
            await self.truncate(ctx.path, length)
            return

        # In the file's turn, as a flush lands, so a read waits for the
        # writes this lands first.
        async def cut() -> None:
            if ctx.write_buf:
                await self._land_held(ctx, ctx.detached or row)
            held = ctx.data or b""
            data = held[:length] + bytes(max(0, length - len(held)))
            landed = (ctx.detached or row).model_copy(update={"size": length})
            for other in self._open_on(ctx.key):
                if other is ctx or other.data is held:
                    other.data = data
                    other.detached = landed
                    other.write_buf = [
                        (at, run[: length - at])
                        for at, run in other.write_buf
                        if at < length
                    ]

        await self._mutate(ctx.key, cut)
