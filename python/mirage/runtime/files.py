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
from collections.abc import Awaitable, Callable, Coroutine, Iterator
from dataclasses import dataclass
from typing import Any, TypeVar

from mirage.bridge.sync import run_async_from_sync
from mirage.commands.builtin.utils.links import link_view
from mirage.commands.config import Context
from mirage.concurrency.limiter import ConcurrencyLimiter
from mirage.context.session_context import (
    Caller,
    awaits_as,
    calls_as,
    current_caller,
)
from mirage.errors.fs import ebadf, einval, eloop, numbered
from mirage.errors.types import OperationNotSupportedError
from mirage.io import IOResult, OpReport
from mirage.mount.core import MountCore
from mirage.runtime.binding import CallerResolver, WorkspaceBinding
from mirage.runtime.constants import ABSENT_PATH, LISTING_ENTRY_CONCURRENCY
from mirage.runtime.errors import CrossMountError
from mirage.runtime.handles.constants import READ_CHUNK
from mirage.runtime.handles.mode import OpenMode
from mirage.runtime.resolver import MountResolver
from mirage.runtime.types import DispatchFn, VFSEntry, VFSStat
from mirage.types import FileStat, PathSpec
from mirage.utils.path import CycleError, norm, resolve_path
from mirage.utils.remnants import entry_name
from mirage.utils.stat_view import (
    DIR_MODE,
    atime_ns,
    content_size,
    device_rdev,
    is_dir,
    is_link,
    mtime_ns,
    posix_mode,
)
from mirage.view.types import LinkResolve
from mirage.workspace.files import Files

logger = logging.getLogger(__name__)

T = TypeVar("T")


def _listed(raw: str, links: set[str]) -> VFSEntry:
    """One listing row before any stat: its slash mark and its link mark.

    The link mark is compared by final segment: backends disagree on
    entry shape (bare names, trailing-slash names, full paths) and the
    name is the part they agree on, the normalization merge_readdir uses.

    Args:
        raw (str): the entry as the listing spelled it.
        links (set[str]): the link names the namespace owes the directory.
    """
    linked = entry_name(raw) in links
    return VFSEntry(path=raw, size=0, is_dir=raw.endswith("/"), is_link=linked)


def stat_row(fs: FileStat) -> VFSStat:
    """Translate one mirage stat row into the struct a guest surface reads.

    Args:
        fs (FileStat): the row the dispatcher answered with.
    """
    return VFSStat(
        size=content_size(fs),
        is_dir=is_dir(fs),
        mode=posix_mode(fs),
        mtime_ns=mtime_ns(fs),
        is_link=is_link(fs),
        rdev=device_rdev(fs),
        atime_ns=atime_ns(fs),
        uid=fs.uid if isinstance(fs.uid, int) else None,
        gid=fs.gid if isinstance(fs.gid, int) else None,
        source=fs,
    )


@dataclass(slots=True)
class Descriptor:
    """One file a guest holds open: the run's core handle on it, the
    position its reads and writes move, and what its open asked for.

    Nothing the guest reads or writes stays here: the core holds it
    (``RuntimeFiles.open``), so every entry point judges, lands and keeps
    an open file one way. A stream and a descriptor over one open share
    this, and with it the position, as POSIX shares an open file
    description.

    Args:
        files (RuntimeFiles): the adapter whose core the handle is on.
        fh (int): the core's handle.
        mode (OpenMode): what the open asked for.
        opened (str): the path it was opened at, which its inode number
            comes from however the file is renamed since.
        directory (bool): it names a directory, which it may not read.
        pos (int): the read/write position.
    """

    files: "RuntimeFiles"
    fh: int
    mode: OpenMode
    opened: str
    directory: bool = False
    pos: int = 0

    @property
    def path(self) -> str:
        """The path its file has now; a rename moves it."""
        return self.files.path_of(self.fh)

    @property
    def size(self) -> int:
        """The file's length as the handle holds it, its writes counted."""
        return self.files.fstat(self.fh).size

    def pread(self, offset: int, size: int) -> bytes:
        """Read at an explicit offset without moving the position.

        Args:
            offset (int): byte offset to read from.
            size (int): byte budget.
        """
        if size <= 0:
            return b""
        return self.files.pread(self.fh, offset, size)

    def read(self, size: int | None = None) -> bytes:
        """Read from the position, advancing it by what was read.

        Args:
            size (int | None): byte budget; None or negative reads to the
                end, a chunk at a time.
        """
        if size is not None and size >= 0:
            chunk = self.pread(self.pos, size)
            self.pos += len(chunk)
            return chunk
        out = bytearray()
        while chunk := self.pread(self.pos, READ_CHUNK):
            out += chunk
            self.pos += len(chunk)
        return bytes(out)

    def pwrite(self, offset: int, data: bytes) -> None:
        """Write at an explicit offset without moving the position; an
        appending handle writes at its end.

        Args:
            offset (int): byte offset to write at.
            data (bytes): the payload.
        """
        if data:
            self.files.pwrite(self.fh, offset, data)

    def write(self, data: bytes) -> None:
        """Write at the position, advancing it; an appending handle writes
        at its end and moves the position past what it wrote.

        Args:
            data (bytes): the payload.
        """
        self.pwrite(self.pos, data)
        self.pos += len(data)

    def seek(self, offset: int, whence: int) -> int | None:
        """Move the position, POSIX whence numbering.

        Args:
            offset (int): displacement from the whence base.
            whence (int): 0 from the start, 1 from the position, 2 from
                the end.

        Returns:
            int | None: the new position, or None when the whence is
            unknown or the target would be negative (the position is
            then untouched).
        """
        if whence == 2:
            base: int | None = self.size
        else:
            base = {0: 0, 1: self.pos}.get(whence)
        if base is None or base + offset < 0:
            return None
        self.pos = base + offset
        return self.pos

    def truncate(self, size: int) -> None:
        """Set the file's length: a shrink drops bytes, growth reads zeros.

        Args:
            size (int): the new length.
        """
        self.files.ftruncate(self.fh, size)

    def land(self) -> None:
        """Land what it wrote, as fsync(2) does."""
        self.files.fsync(self.fh)

    def close(self) -> None:
        """Land what it wrote and let the core's handle go."""
        self.files.close(self.fh)


class RuntimeFiles:
    """The mount-facing op vocabulary a sandboxed runtime encodes into.

    One instruction set (read/write/append/stat/readdir/create/truncate/
    unlink/mkdir/rmdir/rename/symlink/readlink/setattr), one routing
    table, one place that knows an append may have to become a
    whole-file write. The last three reach the name plane rather than a
    backend, which is what lets a guest create a link or chmod a file on
    a mount whose store has neither. Encoders hold one
    of these; they never inherit it, because a monty encoder must
    inherit the engine's own AbstractOS and a wasm encoder is a table of
    preview1 host functions.

    The surface is sync on purpose: it serves code that cannot await,
    and each call blocks its caller until the op is done. A guest's call
    arrives on a worker thread (wasm) or the binding's own thread
    (monty) and hops to the workspace loop running elsewhere; the hop
    carries no contextvars, so a guest's file adapter is built from a binding
    (``of``), whose dispatch replays the launch context (the session,
    the op recorder) around each op. A ``with ws:`` block calls from
    the only thread there is, so its file adapter drives the block's idle loop
    in the caller's own context, a session bound inside the block
    included. Either way the op runs as a shell command's would, and an
    OSError leaves numbered as a syscall's (``numbered``).

    A file the guest opens is a handle on the run's ``MountCore``
    (``open``, ``pread``, ``pwrite``, ``fstat``, ``ftruncate``,
    ``fsync``, ``close``), the open-file layer every entry point shares:
    it holds what the guest read, keeps what it wrote until a close or a
    sync, lands it in the order the writes were made, and keeps a file
    whose name went for the handles open on it. The guest's own table
    keeps only the descriptor number, its position and its flags. A
    removal, a rename, a truncate and a change of times by path go
    through the core too, so the files open on that path follow them.

    Args:
        dispatch (DispatchFn): the workspace dispatch coroutine function.
        loop (asyncio.AbstractEventLoop | None): the loop dispatch
            belongs to; None runs each call on a throwaway loop.
        resolver (MountResolver | None): the workspace mount routing
            table; None means routing questions answer None.
        resolve (LinkResolve | None): where the namespace's links lead a
            path; None while the workspace keeps no links.
        files (Files | None): the files the open-file core runs over,
            through ``dispatch``; None opens nothing.
        caller (Caller | None): who the core's ops run as; None keeps
            the context each op is made in.
    """

    def __init__(
        self,
        dispatch: DispatchFn,
        loop: asyncio.AbstractEventLoop | None,
        resolver: MountResolver | None = None,
        resolve: LinkResolve | None = None,
        files: Files | None = None,
        caller: Caller | None = None,
    ) -> None:
        self._dispatch = dispatch
        self._loop = loop
        self._resolver = resolver
        self._resolve = resolve
        self._core = None if files is None else MountCore(files)
        self._caller = caller
        self._no_append: set[str] = set()
        self._pending: set[asyncio.Task[Any]] = set()
        self._aborted = False
        self._limiter = ConcurrencyLimiter(LISTING_ENTRY_CONCURRENCY)

    @classmethod
    def of(
        cls, ctx: Context, binding: WorkspaceBinding | None
    ) -> "RuntimeFiles | None":
        """The file adapter every engine builds for one run.

        Over the run's files (``ctx.vfs``, whose calls are the program's
        own), the binding's routing table and the namespace's links, each
        made as the run's caller, which ``Runtime.execute`` bound, for a
        guest that calls back from a thread of its own.

        Args:
            ctx (Context): the run's context.
            binding (WorkspaceBinding | None): the runtime's binding;
                None outside a workspace, which has no adapter.
        """
        if binding is None or ctx.vfs is None:
            return None
        caller = current_caller()
        links = link_view(ctx.vfs)
        owner = asyncio.current_task()
        dispatch = awaits_as(caller, ctx.vfs.dispatch)

        async def guarded(
            name: str,
            path: PathSpec,
            /,
            *,
            report: OpReport | None = None,
            **kwargs: Any,
        ) -> tuple[Any, IOResult]:
            if owner is not None and owner.cancelling():
                raise asyncio.CancelledError()
            result = await dispatch(name, path, report=report, **kwargs)
            if owner is not None and owner.cancelling():
                raise asyncio.CancelledError()
            return result

        return cls(
            guarded,
            asyncio.get_running_loop(),
            CallerResolver(binding.resolver, caller),
            None if links is None else calls_as(caller, links.resolve),
            ctx.vfs._over(guarded),
            caller,
        )

    def walked(self, path: str, *, follow: bool = True) -> str:
        """The path an op on ``path`` lands on once the namespace's links
        are followed: the final name too when ``follow``, else only the
        directories above it, since a rename or a removal acts on the
        name itself. One file reads as one path whichever spelling
        reached it, which is how a removal finds the files open on it.

        Args:
            path (str): guest-absolute path, its dots resolved.
            follow (bool): follow a link at the final name too.
        """
        if self._resolve is None:
            return path
        try:
            if follow:
                return resolve_path(self._resolve(path), "/")
            head, _, name = path.rpartition("/")
            above = resolve_path(self._resolve(head or "/"), "/")
        except CycleError:
            raise eloop(path) from None
        return above.rstrip("/") + "/" + name

    async def _call(self, name: str, path: str, /, **kwargs: Any) -> Any:
        async with self._limiter.acquire():
            result, _ = await self._dispatch(
                name, PathSpec.from_str_path(path, cwd="/"), **kwargs
            )
        return result

    async def _tracked(self, pending: Coroutine[Any, Any, T]) -> T:
        if self._aborted:
            pending.close()
            raise asyncio.CancelledError()
        task = asyncio.current_task()
        assert task is not None
        self._pending.add(task)
        try:
            return await pending
        finally:
            self._pending.discard(task)

    async def abort(self) -> None:
        """Stop admitting guest calls and join outstanding host operations."""
        self._aborted = True
        pending = list(self._pending)
        for task in pending:
            task.cancel()
        results = await asyncio.gather(*pending, return_exceptions=True)
        for result in results:
            if isinstance(result, Exception):
                logger.debug(
                    "guest operation failed during abort", exc_info=result
                )

    def _wait(self, pending: Coroutine[Any, Any, T]) -> T:
        try:
            return run_async_from_sync(self._tracked(pending), self._loop)
        except OSError as exc:
            renumbered = numbered(exc)
            if renumbered is exc:
                raise
            raise renumbered from exc

    def call(self, name: str, path: str, /, **kwargs: Any) -> Any:
        """Run one workspace function and return its result.

        Args:
            name (str): the function's name (read, write, stat, ...).
            path (str): guest-absolute virtual path.
        """
        return self._wait(self._call(name, path, **kwargs))

    def _on_core(self, op: Callable[[MountCore], Awaitable[T]]) -> T:
        """Run one op on the run's open-file core, as the run's caller.

        Args:
            op (Callable[[MountCore], Awaitable[T]]): the op, given the
                core.

        Raises:
            OSError: EBADF when this adapter opens nothing.
        """
        core = self._core
        if core is None:
            raise ebadf("/")
        caller = self._caller

        async def run() -> T:
            if caller is None:
                return await op(core)
            return await awaits_as(caller, op)(core)

        return self._wait(run())

    def path_of(self, fh: int) -> str:
        """The path the core's handle ``fh`` is on now; EBADF for any
        other number.

        Args:
            fh (int): the core's handle.
        """
        held = None if self._core is None else self._core.handles.get(fh)
        if held is None:
            raise ebadf(str(fh))
        return held.path

    def open(self, path: str, mode: OpenMode, perm: int | None = None) -> int:
        """Open a file, the open's effect landing before any byte moves
        (``MountCore.open``), and answer the core's handle for it.

        Args:
            path (str): guest-absolute virtual path.
            mode (OpenMode): what the open asked for.
            perm (int | None): the mode bits a create gives the file;
                None takes the mount's default.
        """
        return self._on_core(lambda core: core.open(path, mode, perm))

    def pread(self, fh: int, offset: int, size: int) -> bytes:
        """Read through an open handle: what it holds, judged as a read
        of its path now, with what it wrote and has not landed laid over.

        Args:
            fh (int): the core's handle.
            offset (int): where the read starts.
            size (int): how many bytes, at most.
        """
        path = self.path_of(fh)
        return self._on_core(lambda core: core.read(path, size, offset, fh))

    def pwrite(self, fh: int, offset: int, data: bytes) -> None:
        """Write through an open handle, which keeps the bytes until a
        close or a sync lands them; one that appends writes at its end.

        Args:
            fh (int): the core's handle.
            offset (int): where the write starts.
            data (bytes): the payload.
        """
        path = self.path_of(fh)
        self._on_core(lambda core: core.write(path, data, offset, fh))

    def fstat(self, fh: int) -> VFSStat:
        """The row an open handle stats by, the size it holds counted.

        Args:
            fh (int): the core's handle.
        """
        return stat_row(self._on_core(lambda core: core.fstat(fh)))

    def unlinked(self, fh: int) -> bool:
        """Whether the name an open handle's file had went, so the file
        has no link left.

        Args:
            fh (int): the core's handle.
        """
        held = None if self._core is None else self._core.handles.get(fh)
        return held is not None and held.detached is not None

    def ftruncate(self, fh: int, length: int) -> None:
        """Set the length of the file an open handle is on.

        Args:
            fh (int): the core's handle.
            length (int): the new length.
        """
        self._on_core(lambda core: core.ftruncate(fh, length))

    def fsync(self, fh: int) -> None:
        """Land what an open handle wrote, as fsync(2) does.

        Args:
            fh (int): the core's handle.
        """
        path = self.path_of(fh)
        self._on_core(lambda core: core.flush(path, fh))

    def close(self, fh: int) -> None:
        """Land what an open handle wrote and let it go; a landing that
        fails still lets it go, and is raised.

        Args:
            fh (int): the core's handle.
        """
        self._on_core(lambda core: core.release(fh))

    def prefixes(self) -> list[str]:
        """The workspace mount prefixes, longest first, slash-normalized.

        A mount at `/` is reported like any other. It is not the core's
        business that one prefix happens to claim every path: a runtime
        that cannot serve `/` says so itself (pyodide refuses it,
        because Emscripten already owns that mountpoint) and a runtime
        with a build tree of its own keeps `/` out of its own claim
        table (`WasmView._prefixes`). Deciding it here instead made
        `mount_of` answer None for a workspace whose only mount was the
        root one, so the routing table disagreed with the world.
        """
        if self._resolver is None:
            return []
        out = [norm(prefix) for prefix in self._resolver.prefixes()]
        return sorted(out, key=len, reverse=True)

    def mount_of(self, path: str) -> str | None:
        """The mount prefix serving `path`, longest match first, or None.

        The resolver answers in the mount table's own spelling; this
        surface re-spells to its no-trailing-slash convention, the form
        `prefixes` reports.

        Args:
            path (str): guest-absolute virtual path.
        """
        if self._resolver is None:
            return None
        owner = self._resolver.owner_of(path)
        return None if owner is None else norm(owner)

    def serves(self, path: str) -> bool:
        """Whether the workspace answers for `path`.

        A guest's content calls gate on this: monty refuses a path the
        workspace does not serve, so it reads and writes only the view.
        A mount serves what is under it, and a namespace link serves
        what is reached through it wherever it lives, because the
        dispatcher follows a link outside every mount the same way.
        With no mounts wired there is no scoping, and every path routes
        here.

        Args:
            path (str): guest-absolute virtual path.
        """
        if not self.prefixes() or self.mount_of(path) is not None:
            return True
        if self._resolver is None:
            return False
        directory = "/"
        for name in path.strip("/").split("/"):
            if name in self._resolver.link_children(directory):
                return True
            directory = directory.rstrip("/") + "/" + name
        return False

    def read(
        self,
        path: str,
        *,
        offset: int = 0,
        size: int | None = None,
        raw: bool = False,
        direct: bool = False,
    ) -> bytes:
        """A file's bytes, or the range of them a handle asked for.

        Args:
            path (str): absolute virtual path.
            offset (int): where the range starts.
            size (int | None): its length; None reads to the end.
            raw (bool): the stored bytes rather than a rendering, which
                is what an edit that is written back must start from.
            direct (bool): what the backend holds now, past the file
                cache, the dispatcher's ``direct`` read.
        """
        kwargs: dict[str, Any] = {"filetype": None} if raw else {}
        if offset or size is not None:
            kwargs.update(offset=offset, size=size)
        if direct:
            kwargs["direct"] = True
        data = self.call("read", path, **kwargs)
        if isinstance(data, str):
            return data.encode()
        return bytes(data)

    def write(self, path: str, data: bytes) -> None:
        self.call("write", path, data=data)

    def stat(self, path: str, *, nofollow: bool = False) -> VFSStat:
        """One path's metadata, projected for a guest encoder.

        The projection lives here rather than in each surface so both
        languages build one struct in one tier: preview1 reads the type
        bits out of ``mode`` and drops the rest, monty fills a
        ``StatResult``, Emscripten fills an ``FSAttr``.

        Args:
            path (str): guest-absolute virtual path.
            nofollow (bool): report a trailing symlink itself rather
                than its target (a guest's lstat). The row is then the
                node table's own, so it carries the target string's
                length as the size, the link's mtime, and whatever a
                ``chown -h`` wrote; the dispatcher consumes the flag
                and gates that read exactly as it gates ``readlink``.
        """
        if self._core is None:
            return stat_row(self.call("stat", path, nofollow=nofollow))
        # Through the core, so what the files open there wrote and have
        # not landed counts, as write(2) is seen at once.
        return stat_row(
            self._on_core(lambda core: core.stat(path, not nofollow))
        )

    def stat_or_none(
        self, path: str, *, nofollow: bool = False
    ) -> VFSStat | None:
        """The path's row, or None when the mount says it is not there.

        Only a missing path answers None. Anything else
        raises, since a refusal is not an answer about the path.

        Args:
            path (str): guest-absolute virtual path.
            nofollow (bool): report a trailing symlink itself.
        """
        try:
            return self.stat(path, nofollow=nofollow)
        except FileNotFoundError:
            return None

    def view_stat(self, path: str) -> VFSStat | None:
        """`path`'s row as a runtime may see it, or None.

        Structure is open and content is not. A path in the view
        (``serves``) answers with its mount's own row; any path the
        workspace lists answers as a directory, so the root above nested
        mounts and the directories above a link are directories here as
        they are in a shell, while a withheld surface's files (history,
        the program view) stay unseen. A file's own row decides that,
        not its listing: the history mount lists its one file as empty
        so a traversal never descends into it.

        Args:
            path (str): guest-absolute virtual path.
        """
        row = self.stat_or_none(path)
        if self.serves(path):
            if row is not None:
                return row
        elif row is not None and not row.is_dir:
            return None
        if self.listing_or_none(path) is None:
            return None
        return VFSStat(size=0, is_dir=True, mode=DIR_MODE)

    def listing_or_none(self, path: str) -> list[VFSEntry] | None:
        """The directory's unclassified rows, or None when it is not one.

        The question a guest asks of a path with no row of its own, a
        directory a mount only implies (the root above a nested mount),
        so nothing per entry is stat'd.

        Args:
            path (str): guest-absolute virtual path.
        """
        try:
            return self.readdir(path, classify=False)
        except ABSENT_PATH:
            return None

    def readdir(self, path: str, *, classify: bool = True) -> list[VFSEntry]:
        """List a directory as resolved entries (the TS entry point's shape).

        A backend that slash-marks directories skips the stat; every
        other entry is classified by its own stat, which is RAM when
        the readdir filled the index and a backend request when the
        mount keeps none. The whole listing is one hop to the loop,
        where the stats run together, at most
        ``LISTING_ENTRY_CONCURRENCY`` requests at once across everything
        this adapter serves.

        An entry whose stat fails, for any reason, rides unclassified:
        a size-0 non-directory with no mode and no mtime, the row that
        says "not known". One entry never fails the listing, the way a
        kernel readdir never stats at all. What went wrong is not lost:
        the guest's own stat or open of that entry asks the mount again
        and reports it. Only the listing itself failing fails the call.
        Any failure but a missing path (a dangling link, an entry gone
        since the listing) also warns on the host, since the row the
        guest sees is degraded.

        A row that did stat carries its mode and mtime too, since the
        struct is already in hand: a guest that seeds a whole tree from
        one listing (Emscripten does) then needs no second stat per
        file. The slash-marked and unclassified rows report None for
        both, which is the honest answer for a listing that never
        learned them.

        The link mark comes from the name plane, since no backend
        listing reports a link. One table read per listing, and it only
        ever marks a name the listing itself returned, so a link the
        session hides stays hidden: the dispatcher filtered it out of
        the entries above and an unmatched mark marks nothing. A marked
        row is the link's own, as a guest's lstat reads it, since the
        node table answers that stat and no backend is asked.

        Args:
            path (str): guest-absolute virtual path.
            classify (bool): stat each entry to learn its kind. A guest
                that only needs names (monty's listdir) passes False and
                every row comes back unclassified, one request for the
                listing and none per entry, as a POSIX readdir costs.
        """
        return self._wait(self._list(path, classify))

    async def _list(self, path: str, classify: bool) -> list[VFSEntry]:
        listing = await self._call("readdir", path)
        # After the listing, not before: a directory that will not list
        # (ENOENT, or a link cycle the namespace refuses to resolve)
        # must fail as readdir, not as the mark read.
        links = (
            self._resolver.link_children(path)
            if self._resolver is not None
            else set()
        )
        rows = [_listed(raw, links) for raw in listing]
        if classify:
            # A fixed set of workers, not a task per entry, so a wide
            # directory costs the cap's worth of tasks, never its width.
            pending = [
                (i, row) for i, row in enumerate(rows) if not row.is_dir
            ]
            queue = iter(pending)
            workers = min(LISTING_ENTRY_CONCURRENCY, len(pending))
            await asyncio.gather(
                *(self._classify(path, rows, queue) for _ in range(workers))
            )
        return rows

    async def _classify(
        self,
        directory: str,
        rows: list[VFSEntry],
        queue: Iterator[tuple[int, VFSEntry]],
    ) -> None:
        for index, row in queue:
            rows[index] = await self._classified(directory, row)

    async def _classified(self, directory: str, row: VFSEntry) -> VFSEntry:
        try:
            st = stat_row(
                await self._call("stat", row.path, nofollow=row.is_link)
            )
        except ABSENT_PATH as exc:
            logger.debug(
                "runtime files: readdir %s: stat %s: %s",
                directory,
                row.path,
                exc,
            )
            return row
        except Exception as exc:
            logger.warning(
                "runtime files: readdir %s: stat %s: %s",
                directory,
                row.path,
                exc,
            )
            return row
        return VFSEntry(
            path=row.path,
            size=st.size,
            is_dir=st.is_dir,
            is_link=row.is_link,
            mode=st.mode,
            mtime_ns=st.mtime_ns or 0,
            rdev=st.rdev,
            atime_ns=st.atime_ns,
            uid=st.uid,
            gid=st.gid,
        )

    def truncate(self, path: str, length: int = 0) -> None:
        if length < 0:
            raise einval(path)
        if self._core is None:
            self.call("truncate", path, length=length)
            return
        self._on_core(lambda core: core.truncate(path, length))

    def unlink(self, path: str) -> None:
        """Remove the entry at ``path``; a file open on it keeps what it
        held, as POSIX keeps an open file on its inode.

        Args:
            path (str): guest-absolute virtual path.
        """
        if self._core is None:
            self.call("unlink", path)
            return
        self._on_core(lambda core: core.unlink(path))

    def mkdir(self, path: str, *, parents: bool = False) -> None:
        self.call("mkdir", path, parents=parents)

    def rmdir(self, path: str) -> None:
        self.call("rmdir", path)

    def rename(self, src: str, dst: str) -> None:
        """Rename within one mount.

        Args:
            src (str): guest-absolute source path.
            dst (str): guest-absolute destination path.

        Raises:
            CrossMountError: the two ends resolve to different mounts.
        """
        if self.mount_of(src) != self.mount_of(dst):
            raise CrossMountError(src, dst)
        if self._core is None:
            self.call("rename", src, dst=PathSpec.from_str_path(dst, cwd="/"))
            return
        self._on_core(lambda core: core.rename(src, dst))

    def symlink(self, path: str, target: str) -> None:
        """Create a namespace symlink at `path` pointing at `target`.

        A link is namespace state, so no backend stores one and the
        target is kept verbatim as the guest typed it. The dispatcher
        answers this op from the node table itself, which is why a
        runtime can serve `os.symlink` at all: the dispatcher a surface
        already holds reaches the name plane, not just a mount.

        Args:
            path (str): guest-absolute path of the link to create.
            target (str): link target, stored as typed.
        """
        self.call("symlink", path, target=target)

    def readlink(self, path: str) -> str:
        """The target of the symlink at `path`.

        Args:
            path (str): guest-absolute path of the link.

        Returns:
            str: the stored target.

        Raises:
            OSError: EINVAL when `path` is not a link, which is what the
                node table answers and what POSIX readlink says.
        """
        return str(self.call("readlink", path))

    def setattr(
        self,
        path: str,
        *,
        mode: int | None = None,
        uid: int | str | None = None,
        gid: int | str | None = None,
        atime: str | None = None,
        mtime: str | None = None,
        nofollow: bool = False,
    ) -> None:
        """Write metadata fields, natively where the backend can hold them.

        Every field is passed, unset ones as None, because the dispatcher
        reads the whole set and stores in the namespace overlay whatever
        the backend cannot keep. A mount with no setattr op therefore
        still answers: chmod on an s3 or dropbox mount lands in the name
        plane and stat reports it back. Stored, not enforced; mount mode
        is the access control.

        Args:
            path (str): guest-absolute virtual path.
            mode (int | None): permission bits (e.g. 0o644).
            uid (int | str | None): owner id or name.
            gid (int | str | None): group id or name.
            atime (str | None): ISO access time.
            mtime (str | None): ISO modification time.
            nofollow (bool): write the link entry's own attrs rather
                than its target's (a guest's AT_SYMLINK_NOFOLLOW).
        """
        if self._core is not None and (atime is not None or mtime is not None):
            # A file still open there lands its writes first, or they
            # would stamp over the times.
            self._on_core(lambda core: core.land(path, not nofollow))
        self.call(
            "setattr",
            path,
            mode=mode,
            uid=uid,
            gid=gid,
            atime=atime,
            mtime=mtime,
            nofollow=nofollow,
        )

    def append(self, path: str, data: bytes) -> None:
        """Extend `path` by `data`, falling back to a whole-file write.

        `append` is optional per backend (S3 registers `write` and
        `rename` without it), so a mount that declines is remembered:
        the fallback then costs one failed dispatch per mount rather
        than one per call. The fallback reads the base fresh, a missing
        file starting empty, never a copy from an earlier append: a
        mount without the op can only emulate one by reading and
        rewriting, and an append lands after whatever the file holds
        now, so a write another action made between two appends is
        kept, as O_APPEND keeps it.

        Args:
            path (str): guest-absolute virtual path.
            data (bytes): only the newly appended bytes.
        """
        if self._append_delta(path, data):
            return
        try:
            whole = self.read(path, raw=True, direct=True) + data
        except FileNotFoundError:
            whole = data
        self.write(path, whole)

    def _append_delta(self, path: str, data: bytes) -> bool:
        mount = self.mount_of(path) or path
        if mount in self._no_append:
            return False
        try:
            self.call("append", path, data=data)
        except OperationNotSupportedError:
            self._no_append.add(mount)
            return False
        return True
