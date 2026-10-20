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
import posixpath
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, replace
from typing import Any

from mirage.context import (
    Caller,
    bind_caller,
    current_caller,
    get_current_session,
    reset_caller,
    session_visibility,
)
from mirage.context.session_context import calls_as
from mirage.errors.types import NoMountError
from mirage.io import IOResult, OpReport
from mirage.io.stream import close_quietly, ensure_stream
from mirage.io.types import ByteSource
from mirage.observe import OpRecord
from mirage.observe.context import (
    OpTimer,
    Recorder,
    active_recorder,
    command_records,
    fresh_recorder,
    record,
    start_op,
)
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, MountMode, PathSpec, Visibility
from mirage.utils.hidden import leads_hidden, path_visible
from mirage.utils.path import norm, norm_dir, owner_prefix
from mirage.view.namespace_view import namespace_names
from mirage.view.types import (
    FollowOperands,
    MountView,
    NamespaceLinks,
    SessionBind,
)
from mirage.workspace.types import MountRow


async def _recorded(
    stream: AsyncIterator[bytes], record: Callable[[], None]
) -> AsyncIterator[bytes]:
    """A streamed answer, recorded once it ends.

    The dispatcher stamps the report with the bytes the stream carried when it
    ends, so the record waits for that rather than counting none. The
    caller runs it to its empty first step, inside the ``try``, so a
    stream closed before its first pull is still closed and recorded.

    Args:
        stream (AsyncIterator[bytes]): the dispatcher's stream.
        record (Callable[[], None]): records the op from the report.
    """
    try:
        yield b""
        async for chunk in stream:
            yield chunk
    finally:
        await close_quietly(stream)
        record()


class Files:
    """The typed file API: ``ws.vfs``, ``session.vfs`` and a command's,
    CLI leaf's or runtime's ``ctx.vfs``.

    Every op delegates to the workspace dispatcher, so FUSE and
    ``ws.vfs`` walk the same pipeline as a shell command: link follow,
    session grants, admission policies, cache read-through, namespace
    structure, and write invalidation all fire once, at that one dispatcher.
    The facade keeps only what is its own: the typed surface, op
    recording, and the mount-table helpers. What only the host asks of
    ``ws.vfs`` (the ledger, keeping its mount table in step, the mounts
    FUSE and the runtime's ``open()`` interception ask about) is on
    ``WorkspaceFiles``.

    ``dispatch`` is required, so there is no workspace-less mode. A
    second pipeline here would be a second entry point, and it drifted from
    the real one exactly as expected: it served no cache, saw no
    namespace structure, and fired the gates only when a caller
    remembered to hand it policies. TypeScript's ``Files`` takes
    the same stance.

    The facade runs as one session, ``session_id``, through ``bind``:
    every op is judged under that session's profile (hides, mount
    modes, grants) exactly as a shell line in it would be, so an agent
    whose file tool reads through ``ws.vfs`` is confined the way its
    shell is. None names the workspace's default session as it is when
    the op runs, since a snapshot load can rename it. A session already
    bound when the op arrives (a command's own runtime, a kernel mount
    serving one session) is kept, so the facade never widens the
    caller's view, and the record names the session that judged the
    op. ``Session`` derives a facade for another session over
    the same ledger.

    Every op also takes ``session_id`` for the one-call case, the way
    ``Workspace.shell`` does. One rule decides between them: a shell
    line *sets* the session, an op *inherits* it. So the argument is
    the session to run as when no line is already running, and the
    line's session wins when one is, which is what keeps a handler
    reaching the dispatcher from widening the view it was given.

    A command's own files (its ``Context.vfs``) keep no ledger: calls go
    straight to the dispatcher, which does the line's accounting. They
    carry the line's operand resolution (``follow``) for its globs.
    """

    def __init__(
        self,
        mounts: list[MountRow],
        dispatch: DispatchFn,
        observer: Any | None = None,
        session_id: str | None = None,
        links: NamespaceLinks | None = None,
        bind: SessionBind | None = None,
        records: list[OpRecord] | None = None,
        visibility: Callable[[str | None], Visibility | None] | None = None,
        follow: FollowOperands | None = None,
        ledger: bool = True,
    ) -> None:
        self._mounts: list[MountRow] = sorted(
            mounts, key=lambda m: len(m.prefix), reverse=True
        )
        self._observer = observer
        self._session_id = session_id
        self._links = links
        self._dispatch = dispatch
        self._bind = bind
        self._visibility = visibility
        self._follow = follow
        self._ledger = ledger
        self._records: list[OpRecord] = records if records is not None else []

    @property
    def session_id(self) -> str | None:
        """The session this facade runs as; None for the workspace's
        default session."""
        return self._session_id

    def _for_session(self, session_id: str) -> "Files":
        """The same facade run as another session.

        The mechanism behind ``Session.vfs``, not an entry point of its
        own: a host binds a session with ``ws.session(id)`` (creating
        it when the id is new) or ``Session(ws, id)`` (adopting
        one that exists), so there is one way to say it rather than
        two. Shares the mount table and the op ledger with this one, so
        the workspace-wide account stays one list and a later mount is
        seen by both.

        Args:
            session_id (str): the session whose profile judges the ops.
        """
        derived = Files(
            [],
            self._dispatch,
            observer=self._observer,
            session_id=session_id,
            links=self._links,
            bind=self._bind,
            records=self._records,
            visibility=self._visibility,
        )
        derived._mounts = self._mounts
        return derived

    def _over(self, dispatch: DispatchFn) -> "Files":
        """The same files over another dispatcher, keeping no ledger.

        Args:
            dispatch (DispatchFn): the dispatcher the calls go to.
        """
        derived = Files(
            [],
            dispatch,
            session_id=self._session_id,
            links=self._links,
            visibility=self._visibility,
            follow=self._follow,
            ledger=False,
        )
        derived._mounts = self._mounts
        return derived

    def _served(self) -> list[MountRow]:
        """The mounts the session an op would run as is told of at all,
        hides aside.

        A session's own documents mount is one only it is told of.
        """
        return [
            m
            for m in self._mounts
            if m.visible is None or m.visible(self._session_id)
        ]

    def _vis(self) -> Visibility | None:
        """The visibility of the session an op would run as: the bound
        one, else this facade's own."""
        if self._visibility is None:
            return session_visibility()
        return self._visibility(self._session_id)

    def _shown(self) -> list[MountRow]:
        """The mounts whose root the session sees.

        A hidden mount is left out of every list here, as it is left out
        of a listing, so no list names it.
        """
        vis = self._vis()
        return [m for m in self._served() if path_visible(vis, norm(m.prefix))]

    def mount_prefixes(self) -> list[str]:
        """Return the prefixes of the mounts the session sees.

        Returns:
            list[str]: mount prefixes, longest first.
        """
        return [m.prefix for m in self._shown()]

    def mount_of(self, path: str | PathSpec) -> str | None:
        """The mount prefix serving ``path``, without a trailing slash.

        The one ``RuntimeFiles.mount_of`` gives a guest: where a walk up
        a tree stops, as git stops looking for ``.git`` at a filesystem
        boundary. None for a path the session cannot see. A path a show
        carve-out opens inside a hidden mount names that mount, whose
        root the path itself runs through.

        Args:
            path (str | PathSpec): virtual path.
        """
        virtual = PathSpec.from_str_path(path, cwd="/").virtual
        if not path_visible(self._vis(), virtual):
            return None
        owner = owner_prefix((m.prefix for m in self._served()), virtual)
        return None if owner is None else norm(owner)

    def _is_visible(self, path: str | PathSpec) -> bool:
        """Whether the session sees ``path``: it is not hidden, and no
        link on it leads where the session cannot see.

        The rule the dispatcher refuses a call by. Not a handler's: a
        handler hands its output over as rows (``IOResult.rows``), which
        the command boundary filters by this rule; the command helpers
        read it as ``FilesView.visible``.

        Args:
            path (str | PathSpec): virtual path.
        """
        virtual = PathSpec.from_str_path(path, cwd="/").virtual
        vis = self._vis()
        if not path_visible(vis, virtual):
            return False
        if vis is None or self._links is None:
            return True
        return not leads_hidden(vis, virtual, self._links.symlink_targets())

    def is_mount(self, path: str | PathSpec) -> bool:
        """Whether ``path`` is the root of a mount the session sees.

        Args:
            path (str | PathSpec): virtual path.
        """
        virtual = norm(PathSpec.from_str_path(path, cwd="/").virtual)
        return any(norm(m.prefix) == virtual for m in self._shown())

    def submounts(self, path: str | PathSpec) -> list[str]:
        """The mount roots strictly under ``path``, sorted, without a
        trailing slash, as ``findmnt --submounts`` lists them.

        A mount the session hides still stands where it is: whatever
        removes or renames the folder holding it would take it along. It
        is reported by the nearest folder above it the session sees,
        ``path`` itself when nothing between is visible, so a caller
        refuses that folder without learning the mount's name.

        Args:
            path (str | PathSpec): virtual directory path.
        """
        virtual = norm(PathSpec.from_str_path(path, cwd="/").virtual)
        vis = self._vis()
        if not path_visible(vis, virtual):
            return []
        below = norm_dir(virtual)
        found: set[str] = set()
        for m in self._served():
            root = norm(m.prefix)
            if root == virtual or not norm_dir(root).startswith(below):
                continue
            while root != virtual and not path_visible(vis, root):
                root = posixpath.dirname(root)
            found.add(root)
        return sorted(found)

    def _owner(self, path: str) -> MountRow | None:
        """The mount owning ``path`` by longest prefix, or None."""
        owner = owner_prefix((m.prefix for m in self._mounts), path)
        if owner is None:
            return None
        return next(m for m in self._mounts if m.prefix == owner)

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
            (
                len(v)
                for v in kwargs.values()
                if isinstance(v, (bytes, bytearray))
            ),
            0,
        )

    async def dispatch(
        self, name: str, path: PathSpec, /, **kwargs: Any
    ) -> tuple[Any, IOResult]:
        """``Workspace.dispatch`` as this facade runs it: as its session,
        and recorded on ``records``. The dispatcher ``RuntimeFiles`` drives for
        a ``with ws:`` block, which is a facade caller like FUSE. The
        IOResult is empty: a facade op's account is its record; without a
        ledger the dispatcher's own answer passes through.

        Args:
            name (str): the function's name (read, write, stat, ...).
            path (PathSpec): the virtual path.
            **kwargs: the function's arguments, by its own names.
        """
        if not self._ledger:
            return await self._dispatch(name, path, **kwargs)
        return await self._call(name, path, **kwargs), IOResult()

    async def _call(
        self,
        op: str,
        path: str | PathSpec,
        session_id: str | None = None,
        **kwargs,
    ) -> Any:
        """Run one op through the workspace dispatcher and record it.

        The dispatcher owns the whole pipeline (follow, grants, gates, cache,
        structure, invalidation). On a line this workspace runs, the op
        records where the line records, so its records are the line's;
        anywhere else (outside a line, or on another workspace's) it
        records into its own recorder, handed to this ledger and the
        observer once the op ends, a stream's once it closes. What records it is what
        records a line's calls: the backend and the dispatcher, with the
        tokens they read. An op nothing below recorded (a stat, a listing,
        a warm cache hit, a synthetic namespace answer) is recorded here,
        on the path the dispatcher's report says it ran on, its links
        followed.

        Whether the op is a write is the dispatcher's call too: it reads that
        off the op name, so there is nothing for a caller here to
        declare.

        Args:
            op (str): the op name.
            path (str | PathSpec): the virtual path and its requested spelling.
            session_id (str | None): the session to run as when no line
                is already running; None uses this facade's own.
            **kwargs: op arguments, by the op function's names.
        """
        typed = PathSpec.from_str_path(path, cwd="/")
        if not self._ledger:
            answer, _ = await self._dispatch(op, typed, **kwargs)
            return answer
        timer = start_op()
        report = OpReport()
        seen: list[str] = []
        # Only a line this workspace runs is joined: another workspace's
        # line, or another call's own recorder seen through a shared
        # browser stack, would take this workspace's records.
        line = active_recorder()
        own = (
            None
            if line is not None and line.ledger is self._records
            else fresh_recorder()
        )
        token = (
            None
            if own is None
            else bind_caller(replace(current_caller(), recorder=own))
        )

        async def run() -> tuple[Any, Any]:
            sess = get_current_session()
            if sess is not None:
                seen.append(sess.session_id)
            # Resolved against the root: the dots simplified away for the
            # op, the typed spelling kept for the walk that proves them.
            return await self._dispatch(
                op,
                typed,
                report=report,
                **kwargs,
            )

        # The op's own list gathers every record made below it; a command
        # the op runs in on that line (a handler reaching ``ws.vfs``) is
        # charged them once the op ends.
        held = None if own is not None else current_caller().command_sink
        outer = held[0] if held is not None else None
        try:
            with command_records(own=True) as mine:
                caller = current_caller()
                try:
                    bound = (
                        self._session_id if session_id is None else session_id
                    )
                    result, _ = await (
                        run() if self._bind is None else self._bind(bound, run)
                    )
                except BaseException:
                    # Anything raised after the op ran (a post_vfs deny, a
                    # hard output cap, a bookkeeping failure) suppresses the
                    # result, not the effect, so observation must reflect
                    # the op before the error propagates. The dispatcher
                    # stamps the report at the moment of completion, so even
                    # a foreign error the dispatcher never defined leaves the
                    # transfer on the books.
                    self._settle(
                        op, typed, report, None, kwargs, timer, mine, caller
                    )
                    self._hand_over(own, seen, mine, outer)
                    raise
                finally:
                    # A write owns its source even when it never reaches
                    # the dispatcher (an unknown session refused at the bind).
                    if op in ("write", "append"):
                        await close_quietly(kwargs.get("data"))
        finally:
            if token is not None:
                reset_caller(token)
        if op == "write" and kwargs.get("admit_only"):
            self._hand_over(own, seen, mine, outer)
            return result

        def settle(answer: Any) -> None:
            self._settle(
                op, typed, report, answer, kwargs, timer, mine, caller
            )
            self._hand_over(own, seen, mine, outer)

        if hasattr(result, "__aiter__"):
            recorded = _recorded(result, lambda: settle(None))
            await recorded.__anext__()
            return recorded
        settle(result)
        return result

    def _settle(
        self,
        op: str,
        typed: PathSpec,
        report: OpReport,
        answer: Any,
        kwargs: dict[str, Any],
        timer: OpTimer,
        mine: list[OpRecord],
        caller: Caller,
    ) -> None:
        """Record an op that ran and that nothing below recorded.

        The dispatcher names the server when it was not the owning mount (a
        warm cache hit, a synthetic namespace answer): neither moved
        bytes over the network, and "ram" is what ``OpRecord.is_cache``
        reads. It names the moved bytes when the delivered result no
        longer measures them, because a cap truncated it or a refusal
        withheld it entirely.

        Args:
            op (str): the op name.
            typed (PathSpec): the path as asked.
            report (OpReport): the dispatcher's account of what ran.
            answer (Any): what the op returned, None when withheld.
            kwargs (dict[str, Any]): the op's arguments.
            timer (OpTimer): the stopwatch opened when the op started.
            mine (list[OpRecord]): what the op recorded below.
            caller (Caller): the op's caller, its recorder bound.
        """
        if mine or not report.completed:
            return
        ran = report.path or typed.virtual
        owner = self._owner(ran)
        if owner is None:
            return
        moved = report.bytes
        calls_as(caller, record)(
            op,
            ran,
            report.source or owner.resource_type,
            moved
            if moved is not None
            else self._payload_bytes(answer, kwargs),
            timer,
        )

    def _hand_over(
        self,
        own: Recorder | None,
        seen: list[str],
        mine: list[OpRecord],
        outer: list[OpRecord] | None,
    ) -> None:
        """Hand an op's records on once it ended: its own to the ledger
        and the observer, while an op on a running line left them with the
        line; and each to the command the op ran in, if any.

        Args:
            own (Recorder | None): the recorder the op opened, None when
                it recorded into a line's.
            seen (list[str]): the session the op ran as, once known.
            mine (list[OpRecord]): what the op recorded.
            outer (list[OpRecord] | None): the records of the command the
                op ran in, None outside one.
        """
        if outer is not None:
            outer.extend(mine)
        if own is None or not own.sink:
            return
        records = list(own.sink)
        own.sink.clear()
        self._records.extend(records)
        if self._observer is not None:
            session = self._session_for(seen)
            for rec in records:
                asyncio.ensure_future(self._observer.log_op(rec, session))

    def _session_for(self, seen: list[str]) -> str:
        """The session id a record carries: the one the op ran as, else
        this facade's own, else the unbound entry point's empty id.

        Args:
            seen (list[str]): the session the op ran as, once known.
        """
        if seen:
            return seen[0]
        return self._session_id if self._session_id is not None else ""

    async def read(
        self,
        path: str | PathSpec,
        offset: int = 0,
        size: int | None = None,
        raw: bool = False,
        *,
        session_id: str | None = None,
    ) -> bytes:
        """Read file content.

        ``raw`` asks for the stored bytes, skipping a filetype-scoped
        read op the mount registers for this extension and the file
        cache a command's rendered read may have filled. Read-modify-
        write is what needs it: the merged buffer goes back through
        ``write``, which stores, so reading the rendering would store
        the rendering over the file. TypeScript spells the same thing
        ``readFile(path, {raw: true})``.

        Args:
            path (str | PathSpec): Virtual path.
            offset (int): Byte offset for range reads.
            size (int | None): Number of bytes for range reads.
            raw (bool): Read stored bytes rather than a rendered form.
            session_id (str | None): Session to run as outside a line.

        Returns:
            bytes: File content.
        """
        kwargs: dict[str, Any] = {"filetype": None} if raw else {}
        if offset or size is not None:
            return await self._call(
                "read", path, session_id, offset=offset, size=size, **kwargs
            )
        return await self._call("read", path, session_id, **kwargs)

    async def read_stream(
        self,
        path: str | PathSpec,
        raw: bool = False,
        *,
        session_id: str | None = None,
    ) -> AsyncIterator[bytes]:
        """Read file content as the caller pulls it.

        The first chunk is read before this returns, so a missing file
        fails here rather than at the first pull. A cold read fills the
        cache as it is pulled, and the read is recorded once the stream
        ends. A read the dispatcher answers whole (a warm copy, a rendering, a
        backend with no stream) arrives as one chunk.

        Args:
            path (str | PathSpec): Virtual path.
            raw (bool): Read stored bytes rather than a rendered form.
            session_id (str | None): Session to run as outside a line.
        """
        kwargs: dict[str, Any] = {"filetype": None} if raw else {}
        result = await self._call(
            "read", path, session_id, stream=True, **kwargs
        )
        return ensure_stream(result)

    async def write(
        self,
        path: str | PathSpec,
        data: ByteSource,
        *,
        session_id: str | None = None,
    ) -> None:
        """Write file content.

        Args:
            path (str | PathSpec): Virtual path.
            data (ByteSource): Bytes or a single-consumer async byte source.
            session_id (str | None): Session to run as outside a line.
        """
        await self._call("write", path, session_id, data=data)

    async def append(
        self,
        path: str | PathSpec,
        data: ByteSource,
        *,
        session_id: str | None = None,
    ) -> None:
        """Append data to a file.

        Args:
            path (str | PathSpec): Virtual path.
            data (ByteSource): Bytes or a single-consumer async byte source.
            session_id (str | None): Session to run as outside a line.
        """
        await self._call("append", path, session_id, data=data)

    async def pwrite(
        self,
        path: str | PathSpec,
        data: bytes,
        offset: int,
        *,
        session_id: str | None = None,
    ) -> None:
        """Write bytes at an offset, keeping the rest of the file.

        pwrite(2): the bytes outside ``[offset, offset + len(data))``
        stay, a gap past the end reads back as zeros, and a missing file
        is created. It is one write at the dispatcher, so a session that may
        write the file and not read it can still do it.

        Args:
            path (str | PathSpec): Virtual path.
            data (bytes): The bytes to write.
            offset (int): Where the first of them lands.
            session_id (str | None): Session to run as outside a line.
        """
        await self._call("pwrite", path, session_id, data=data, offset=offset)

    async def stat(
        self,
        path: str | PathSpec,
        *,
        nofollow: bool = False,
        fresh: bool = False,
        session_id: str | None = None,
    ) -> FileStat:
        """One path's row.

        Args:
            path (str | PathSpec): Virtual path.
            nofollow (bool): Report a trailing symlink itself rather
                than its target (lstat), which is how an exclusive open
                learns a dangling link is a name that is there.
            fresh (bool): Ask the backend past the mount's listing index
                and reconcile the index and file cache with its answer.
            session_id (str | None): Session to run as outside a line.
        """
        options = {}
        if nofollow:
            options["nofollow"] = True
        if fresh:
            options["fresh"] = True
        return await self._call("stat", path, session_id, **options)

    async def readdir(
        self, path: str | PathSpec, *, session_id: str | None = None
    ) -> list[str]:
        return await self._call("readdir", path, session_id)

    # The three probes below answer "is this path there?", so only a
    # genuine missing path may read back as False: the typed registry
    # miss (NoMountError) and the backend's own absence. An auth
    # failure, a timeout, or a backend bug is not an answer to that
    # question; swallowing it would let a caller act on a false
    # "missing" (overwrite, recreate, skip). Mirrors the TS facade.
    async def exists(
        self, path: str | PathSpec, *, session_id: str | None = None
    ) -> bool:
        """True when a stat answers for the path.

        Args:
            path (str | PathSpec): Virtual path.
            session_id (str | None): Session to run as outside a line.
        """
        try:
            await self.stat(path, session_id=session_id)
        except (FileNotFoundError, NotADirectoryError, NoMountError):
            return False
        return True

    async def is_dir(
        self, path: str | PathSpec, *, session_id: str | None = None
    ) -> bool:
        """True when the path stats as a directory.

        Args:
            path (str | PathSpec): Virtual path.
            session_id (str | None): Session to run as outside a line.
        """
        try:
            st = await self.stat(path, session_id=session_id)
        except (FileNotFoundError, NotADirectoryError, NoMountError):
            return False
        return st.type == FileType.DIRECTORY

    async def is_file(
        self, path: str | PathSpec, *, session_id: str | None = None
    ) -> bool:
        """True when the path stats as anything but a directory.

        Args:
            path (str | PathSpec): Virtual path.
            session_id (str | None): Session to run as outside a line.
        """
        try:
            st = await self.stat(path, session_id=session_id)
        except (FileNotFoundError, NotADirectoryError, NoMountError):
            return False
        return st.type != FileType.DIRECTORY

    async def list_files(
        self, path: str | PathSpec, *, session_id: str | None = None
    ) -> list[str]:
        """Basenames of the directory's files, directories dropped.

        Args:
            path (str | PathSpec): Virtual path.
            session_id (str | None): Session to run as outside a line.
        """
        files = []
        for entry in await self.readdir(path, session_id=session_id):
            if await self.is_file(entry, session_id=session_id):
                files.append(entry.rstrip("/").rsplit("/", 1)[-1])
        return files

    async def mkdir(
        self, path: str | PathSpec, *, session_id: str | None = None
    ) -> None:
        await self._call("mkdir", path, session_id)

    async def unlink(
        self, path: str | PathSpec, *, session_id: str | None = None
    ) -> None:
        """Delete file.

        Args:
            path (str | PathSpec): Virtual path.
            session_id (str | None): Session to run as outside a line.
        """
        await self._call("unlink", path, session_id)

    async def rmdir(
        self, path: str | PathSpec, *, session_id: str | None = None
    ) -> None:
        await self._call("rmdir", path, session_id)

    async def rename(
        self,
        src: str | PathSpec,
        dst: str | PathSpec,
        *,
        session_id: str | None = None,
    ) -> None:
        """Rename file or directory within one mount.

        Both ends must resolve to the same mount: a mount is a
        filesystem boundary, and the dispatcher answers EXDEV across
        two, which a kernel-facing whole-workspace FUSE mount needs so
        `mv` between two backends falls back to its copy+unlink path.

        Args:
            src (str | PathSpec): Source virtual path.
            dst (str | PathSpec): Destination virtual path.
            session_id (str | None): Session to run as outside a line.

        Raises:
            OSError: EXDEV when the two ends resolve to different
                mounts, ENOENT when a parent directory is missing.
        """
        await self._call(
            "rename", src, session_id, dst=PathSpec.from_str_path(dst, cwd="/")
        )

    async def create(
        self, path: str | PathSpec, *, session_id: str | None = None
    ) -> None:
        await self._call("create", path, session_id)

    async def symlink(
        self,
        path: str | PathSpec,
        target: str,
        *,
        session_id: str | None = None,
    ) -> None:
        """Create a namespace symlink at ``path``.

        Routed through the dispatcher like every write: session grants and
        admission policies fire on the link's turf, and the write lands
        on the ledger. The target is stored verbatim as typed.

        Args:
            path (str | PathSpec): Virtual path of the link.
            target (str): What the link points to, as typed.
            session_id (str | None): Session to run as outside a line.

        Raises:
            FileExistsError: something is already at ``path`` (a file, a
                directory, another link, a mount root). symlink(2) never
                overwrites, and the dispatcher is the layer that can see both
                planes to tell.
            FileNotFoundError: the directory ``path`` would sit in is
                absent.
            NotADirectoryError: a non-directory stands where that
                directory, or one above it, should be.
        """
        await self._call("symlink", path, session_id, target=target)

    async def readlink(
        self, path: str | PathSpec, *, session_id: str | None = None
    ) -> str:
        """The stored target of the link at ``path``.

        Args:
            path (str | PathSpec): Virtual path of the link.
            session_id (str | None): Session to run as outside a line.

        Raises:
            OSError: EINVAL when the path is not a link.
        """
        return await self._call("readlink", path, session_id)

    async def setattr(
        self,
        path: str | PathSpec,
        *,
        mode: int | None = None,
        uid: int | str | None = None,
        gid: int | str | None = None,
        atime: str | None = None,
        mtime: str | None = None,
        nofollow: bool = False,
        session_id: str | None = None,
    ) -> dict[str, int | str]:
        """Write metadata fields, natively where the backend can hold them.

        Every field is passed, unset ones as None, because the dispatcher
        reads the whole set and stores in the namespace overlay whatever
        the backend cannot keep. A mount with no setattr op therefore
        still answers: a chmod on an s3 or dropbox mount lands in the
        name plane and stat reports it back. Stored, not enforced; the
        mount mode is the access control.

        Args:
            path (str | PathSpec): Virtual path.
            mode (int | None): permission bits (e.g. 0o644).
            uid (int | str | None): owner id or name.
            gid (int | str | None): group id or name.
            atime (str | None): ISO access time.
            mtime (str | None): ISO modification time.
            nofollow (bool): write the link entry's own attrs rather
                than its target's (the ``-h`` family).
            session_id (str | None): Session to run as outside a line.

        Returns:
            dict[str, int | str]: the fields the backend could not keep,
                which the dispatcher stored in the overlay instead.
        """
        return await self._call(
            "setattr",
            path,
            session_id,
            mode=mode,
            uid=uid,
            gid=gid,
            atime=atime,
            mtime=mtime,
            nofollow=nofollow,
        )

    async def getxattr(
        self,
        path: str | PathSpec,
        name: str,
        *,
        nofollow: bool = False,
        session_id: str | None = None,
    ) -> bytes:
        """One extended attribute's value.

        The node table answers with what a caller set.

        Args:
            path (str | PathSpec): Virtual path.
            name (str): Attribute name.
            nofollow (bool): read a link entry's own attributes rather
                than its target's.
            session_id (str | None): Session to run as outside a line.

        Raises:
            OSError: the attribute-not-set errno (ENODATA on Linux,
                ENOATTR on macOS) when the path has no such attribute.
        """
        return await self._call(
            "getxattr", path, session_id, name=name, nofollow=nofollow
        )

    async def listxattr(
        self,
        path: str | PathSpec,
        *,
        nofollow: bool = False,
        session_id: str | None = None,
    ) -> list[str]:
        """Every extended attribute name a path carries, sorted.

        Args:
            path (str | PathSpec): Virtual path.
            nofollow (bool): list a link entry's own attributes.
            session_id (str | None): Session to run as outside a line.
        """
        return await self._call(
            "listxattr", path, session_id, nofollow=nofollow
        )

    async def setxattr(
        self,
        path: str | PathSpec,
        name: str,
        value: bytes,
        *,
        create: bool = False,
        replace: bool = False,
        nofollow: bool = False,
        session_id: str | None = None,
    ) -> None:
        """Store an extended attribute on a path.

        Stored on the path's namespace node, so it works on every
        backend and moves with a rename.

        Args:
            path (str | PathSpec): Virtual path.
            name (str): Attribute name.
            value (bytes): Attribute value.
            create (bool): fail with EEXIST when the attribute is set
                (XATTR_CREATE).
            replace (bool): fail with the attribute-not-set errno when
                it is not (XATTR_REPLACE).
            nofollow (bool): write a link entry's own attributes.
            session_id (str | None): Session to run as outside a line.
        """
        await self._call(
            "setxattr",
            path,
            session_id,
            name=name,
            value=value,
            create=create,
            replace=replace,
            nofollow=nofollow,
        )

    async def removexattr(
        self,
        path: str | PathSpec,
        name: str,
        *,
        nofollow: bool = False,
        session_id: str | None = None,
    ) -> None:
        """Drop an extended attribute from a path.

        Args:
            path (str | PathSpec): Virtual path.
            name (str): Attribute name.
            nofollow (bool): drop from a link entry itself.
            session_id (str | None): Session to run as outside a line.

        Raises:
            OSError: the attribute-not-set errno when it is not set.
        """
        await self._call(
            "removexattr", path, session_id, name=name, nofollow=nofollow
        )

    async def truncate(
        self,
        path: str | PathSpec,
        length: int,
        *,
        session_id: str | None = None,
    ) -> None:
        """Truncate file to given length.

        Args:
            path (str | PathSpec): Virtual path.
            length (int): Target length in bytes.
            session_id (str | None): Session to run as outside a line.
        """
        await self._call("truncate", path, session_id, length=length)


class WorkspaceFiles(Files):
    """``ws.vfs``: the files the host holds, with what only the host asks.

    The op ledger every ledgered facade appends to (``records``, with
    the network/cache split derived from it), the mount table kept in
    step with the workspace's (``set_mounts``, ``unmount``), and the
    mount questions FUSE and the runtime's ``open()`` interception ask
    (``unsized_mounts``, ``writable_mounts``, ``is_mounted``). The
    ``Files`` a handler, a CLI leaf, a runtime or ``session.vfs`` gets
    is a facade of its own, on which these would change or report only
    that facade, so it is a plain ``Files``.
    """

    @property
    def records(self) -> list[OpRecord]:
        """The op ledger: every facade op lands here, and the executor
        appends each shell line's ops too, so this is the one
        workspace-wide account."""
        return self._records

    def set_mounts(self, mounts: list[MountRow]) -> None:
        """Refresh mount metadata without replacing the facade or its ledger.

        Args:
            mounts (list[MountRow]): the workspace's current mount table.
        """
        # In place, so a facade derived for a session sees the
        # refreshed table through the list it shares.
        self._mounts[:] = sorted(
            mounts, key=lambda m: len(m.prefix), reverse=True
        )

    def unsized_mounts(self, root_prefix: str = "") -> list[tuple[str, str]]:
        """Mounts the session sees whose files cannot be sized without
        reading them.

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
        for m in self._shown():
            if root and not (
                m.prefix.rstrip("/") == root or m.prefix.startswith(root + "/")
            ):
                continue
            if not m.sizes_always_known:
                found.append((m.prefix, m.resource_type))
        return found

    def writable_mounts(self, root_prefix: str = "") -> list[tuple[str, str]]:
        """Mounts the session sees that accept writes, in mount
        resolution order.

        Args:
            root_prefix (str): when non-empty, only consider the mount
                serving this prefix and anything nested under it, matching
                how a scoped mount narrows the tree.

        Returns:
            list[tuple[str, str]]: (prefix, resource_type) pairs.
        """
        root = root_prefix.rstrip("/")
        found = []
        for m in self._shown():
            if root and not (
                m.prefix.rstrip("/") == root or m.prefix.startswith(root + "/")
            ):
                continue
            if m.mode is not MountMode.READ:
                found.append((m.prefix, m.resource_type))
        return found

    def unmount(self, prefix: str) -> None:
        """Drop a mount the workspace removed from the mount table.

        Args:
            prefix (str): the removed mount's prefix.
        """
        norm = norm_dir(prefix)
        # In place, for the same reason ``set_mounts`` is: a facade
        # derived for a session shares this list, and a retained one
        # must stop reporting a mount the workspace dropped.
        self._mounts[:] = [m for m in self._mounts if m.prefix != norm]

    @property
    def network_bytes(self) -> int:
        """Total bytes transferred over the network."""
        return sum(r.bytes for r in self.records if not r.is_cache)

    @property
    def cache_bytes(self) -> int:
        """Total bytes served from cache."""
        return sum(r.bytes for r in self.records if r.is_cache)

    def is_mounted(self, path: str) -> bool:
        """Check if a path is under a mount someone made.

        Used by the open()/os interception to decide whether a path is a
        workspace path (route through ops) or a real OS path (pass through).
        The scratch root the workspace adds when no mount claims ``/`` is
        skipped on purpose: nobody mounted it, and it matches every
        absolute path, so counting it would hijack real filesystem paths
        (a FUSE mountpoint, ``/tmp``) into ops. A mount made at ``/`` is the
        workspace's root and claims every path, as it does for a guest. A
        relative path names the process's working directory, which the
        interception leaves alone whatever is mounted. Routing to the anchor
        for ops themselves still happens at the dispatcher; this gate is only
        about what the interception should leave alone.

        A mount the session hides counts as well: its paths route to
        the dispatcher, which refuses them, never to the real filesystem.

        Args:
            path (str): Virtual path.

        Returns:
            bool: True if path is under a mount other than the anchor.
        """
        if not path.startswith("/"):
            return False
        return (
            owner_prefix(
                (m.prefix for m in self._mounts if not m.anchor), path
            )
            is not None
        )


@dataclass(frozen=True)
class FilesNamespace:
    """What a session's files hold of the namespace, hides aside.

    The link table and the mount table as the workspace keeps them,
    hidden entries included, so it is never a handler's: a handler asks
    ``Files`` (``mount_of``, ``submounts``), which apply the session's
    hides, and the command helpers read ``FilesView``, which applies
    them. The code that walks the namespace beside the
    dispatcher reads it: the mount core and the file tool mapping a path
    the way the dispatcher does, the runtime's descriptors.

    Args:
        links (NamespaceLinks | None): the workspace link table,
            unfiltered by any session's hides.
        follow (FollowOperands | None): the line's operand resolution a
            command's globs give their matches.
        vis (Callable[[], Visibility | None]): the visibility of the
            session an op would run as.
        mounts (Callable[[], list[MountRow]]): the mounts that session
            is told of at all, hides aside.
    """

    links: NamespaceLinks | None
    follow: FollowOperands | None
    vis: Callable[[], Visibility | None]
    mounts: Callable[[], list[MountRow]]


def namespace_of(files: Files) -> FilesNamespace:
    """The namespace a session's files hold, for the code that walks it
    beside the dispatcher; never a handler's (``FilesNamespace``).

    Args:
        files (Files): the session's files.
    """
    return FilesNamespace(
        links=files._links,
        follow=files._follow,
        vis=files._vis,
        mounts=files._served,
    )


@dataclass(frozen=True)
class FilesView:
    """What a session's files show of the namespace, the session's hides
    applied.

    The link and mount tables are read here, beside the dispatcher that
    answers from them, and filtered by the rule it refuses a call by
    (``visible``), so the command helpers that walk the
    namespace (``links_of``, ``mounts_of``, globs, ``find -L``, ``cp
    -L``, ``du``) read no table and filter no hide of their own: a
    hidden link, or one that leads where the session cannot see, has no
    row and no target; a hidden mount is a boundary a walk stops at but
    is never named.

    Args:
        linked (bool): whether a link table stands behind the files.
        link_at (Callable[[str], FileStat | None]): the link standing at
            a path, its own row; None where none stands or the session
            cannot see it.
        links_below (Callable[[str], list[tuple[str, FileStat]]]): the
            links under a directory the session sees, with their rows.
        resolve (Callable[[str], str]): where a path the session sees
            leads, every link followed; a hidden one is left as typed.
            Raises CycleError where a link loop stands in the walk.
        mounts (Callable[[bool], MountView]): where the mount
            boundaries are, for a walk through the dispatcher (True) or
            one bound to a mount.
        owed (Callable[[str], list[str]]): the names a directory holds
            only as namespace structure: the mounts below it and its
            links, by their first segment under it.
        vis (Callable[[], Visibility | None]): the visibility of the
            session an op would run as.
        visible (Callable[[str | PathSpec], bool]): whether the session
            sees a path: it is not hidden, and no link on it leads where
            the session cannot see. The rule the dispatcher refuses a call
            by, for what a helper holds in data of its own (a link's
            target, git's index) and the rows the command boundary
            filters.
        follow (FollowOperands | None): the line's operand resolution a
            command's globs give their matches.
    """

    linked: bool
    link_at: Callable[[str], FileStat | None]
    links_below: Callable[[str], list[tuple[str, FileStat]]]
    resolve: Callable[[str], str]
    mounts: Callable[[bool], MountView]
    owed: Callable[[str], list[str]]
    vis: Callable[[], Visibility | None]
    visible: Callable[[str | PathSpec], bool]
    follow: FollowOperands | None


def _mount_view(files: Files, crossing: bool) -> MountView:
    """Where the mount boundaries are, as the session the files run as
    sees them.

    Every mount below a path, hidden or not, is a boundary a backend's
    own walk stops at: a mount the session cannot see still shadows the
    parent backend's keys under its prefix. Only the visible ones are
    ever named. A walk through the dispatcher (``crossing``) descends
    into each mount itself, so it has no boundary to stop at: no mount
    below a path, and no mount root; and it takes no mount's shortcut,
    so no mount answers a function for it, caps its globs or narrows
    its search.

    Args:
        files (Files): the session's files.
        crossing (bool): the walk goes through the dispatcher.
    """

    def below(virtual: str) -> list[str]:
        if crossing:
            return []
        base = norm_dir(virtual)
        return [
            m.prefix.rstrip("/") or "/"
            for m in sorted(files._served(), key=lambda m: m.prefix)
            if m.prefix != base and m.prefix.startswith(base)
        ]

    def visible_below(virtual: str) -> list[str]:
        vis = files._vis()
        return [root for root in below(virtual) if path_visible(vis, root)]

    def owner(virtual: str) -> MountRow | None:
        served = files._served()
        found = owner_prefix([m.prefix for m in served], virtual)
        return next((m for m in served if m.prefix == found), None)

    def is_root(virtual: str) -> bool:
        if crossing:
            return False
        return any(m.prefix == norm_dir(virtual) for m in files._served())

    def root_of(virtual: str) -> str:
        row = owner(virtual)
        return row.prefix if row is not None else "/"

    def max_du_entries(virtual: str) -> int | None:
        row = owner(virtual)
        return row.max_du_entries if row is not None else None

    def answers(virtual: str, name: str) -> bool:
        row = None if crossing else owner(virtual)
        return row is not None and name in row.calls

    def max_glob_matches(virtual: str) -> int | None:
        row = None if crossing else owner(virtual)
        return row.max_glob_matches if row is not None else None

    def searchable(virtual: str) -> tuple[str, ...] | None:
        row = None if crossing else owner(virtual)
        return row.searchable if row is not None else None

    return MountView(
        descendants=below,
        visible_descendants=visible_below,
        is_root=is_root,
        root_of=root_of,
        max_du_entries=max_du_entries,
        answers=answers,
        max_glob_matches=max_glob_matches,
        searchable=searchable,
    )


def view_of(files: Files) -> FilesView:
    """The namespace a session's files show, its hides applied, for the
    command helpers that walk it (``FilesView``).

    Args:
        files (Files): the session's files.
    """
    table = files._links

    def link_at(virtual: str) -> FileStat | None:
        if table is None or not files._is_visible(virtual):
            return None
        return table.link_stat_at(virtual)

    def links_below(directory: str) -> list[tuple[str, FileStat]]:
        if table is None:
            return []
        return [
            (path, row)
            for path, row in table.link_stats_below(directory)
            if files._is_visible(path)
        ]

    def resolve(virtual: str) -> str:
        if table is None or not path_visible(files._vis(), virtual):
            return virtual
        return posixpath.normpath(table.follow(virtual))

    def owed(directory: str) -> list[str]:
        return namespace_names(
            files._vis(), [m.prefix for m in files._served()], table, directory
        )

    return FilesView(
        linked=table is not None,
        link_at=link_at,
        links_below=links_below,
        resolve=resolve,
        mounts=functools.partial(_mount_view, files),
        owed=owed,
        vis=files._vis,
        visible=files._is_visible,
        follow=files._follow,
    )
