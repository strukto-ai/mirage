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
from collections.abc import AsyncIterator, Callable
from dataclasses import replace
from typing import Any, Literal, cast, overload

from mirage.context import (
    Caller,
    bind_caller,
    current_caller,
    get_current_session,
    reset_caller,
    session_visibility,
)
from mirage.context.session_context import calls_as, effective_path_mode
from mirage.errors.types import NoMountError
from mirage.io import IOResult, OpReport
from mirage.io.stream import close_quietly, ensure_stream
from mirage.io.types import ByteSource
from mirage.observe.context import (
    OpTimer,
    active_recorder,
    command_records,
    fresh_recorder,
    record,
)
from mirage.observe.record import OpRecord, Recorder
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.utils.clock import Clock, SystemClock
from mirage.utils.path import owner_prefix
from mirage.view.types import FollowOperands, SessionBind
from mirage.workspace.dispatcher.reader import NamespaceReader


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
    The facade keeps only what is its own: the typed surface and op
    recording. The link and mount tables are the namespace's the
    dispatcher answers from, read through the ``NamespaceReader`` it
    hands out for the session an op runs as (``namespace``), which the
    mount helpers here answer from.
    What only the host asks of ``ws.vfs`` (the ledger, the mounts FUSE
    and the runtime's ``open()`` interception ask about) is on
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
        dispatch: DispatchFn,
        namespace: Callable[[str | None], NamespaceReader] | None = None,
        observer: Any | None = None,
        session_id: str | None = None,
        bind: SessionBind | None = None,
        records: list[OpRecord] | None = None,
        follow: FollowOperands | None = None,
        ledger: bool = True,
        clock: Clock | None = None,
    ) -> None:
        self._clock: Clock = clock if clock is not None else SystemClock()
        self._namespace = namespace
        self._observer = observer
        self._session_id = session_id
        self._dispatch = dispatch
        self._bind = bind
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
        two. Shares the op ledger with this one, so the workspace-wide
        account stays one list, and reads the same dispatcher's tables,
        so a later mount is seen by both.

        Args:
            session_id (str): the session whose profile judges the ops.
        """
        return Files(
            self._dispatch,
            self._namespace,
            observer=self._observer,
            session_id=session_id,
            bind=self._bind,
            records=self._records,
            clock=self._clock,
        )

    def _over(self, dispatch: DispatchFn) -> "Files":
        """The same files over another dispatcher, keeping no ledger.

        Args:
            dispatch (DispatchFn): the dispatcher the calls go to.
        """
        return Files(
            dispatch,
            self._namespace,
            session_id=self._session_id,
            follow=self._follow,
            ledger=False,
        )

    def _reader(self) -> NamespaceReader:
        """The namespace as the session an op would run as sees it: the
        workspace's, else, for files outside one, no link and no mount
        under the bound session's hides."""
        if self._namespace is None:
            return NamespaceReader(
                None, list, self._session_id, session_visibility
            )
        return self._namespace(self._session_id)

    def mount_prefixes(self) -> list[str]:
        """Return the prefixes of the mounts the session sees.

        Returns:
            list[str]: mount prefixes, longest first.
        """
        return [m.prefix for m in self._reader().shown()]

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
        return self._reader().mount_of(path)

    def is_mount(self, path: str | PathSpec) -> bool:
        """Whether ``path`` is the root of a mount the session sees.

        Args:
            path (str | PathSpec): virtual path.
        """
        return self._reader().is_mount(path)

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
        return self._reader().submounts(path)

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

    @overload
    async def _call(
        self,
        op: Literal["read", "getxattr"],
        path: str | PathSpec,
        session_id: str | None = None,
        *,
        stream: Literal[False] = False,
        **kwargs: Any,
    ) -> bytes: ...

    @overload
    async def _call(
        self,
        op: Literal["read"],
        path: str | PathSpec,
        session_id: str | None = None,
        *,
        stream: Literal[True],
        **kwargs: Any,
    ) -> ByteSource: ...

    @overload
    async def _call(
        self,
        op: Literal["stat"],
        path: str | PathSpec,
        session_id: str | None = None,
        **kwargs: Any,
    ) -> FileStat: ...

    @overload
    async def _call(
        self,
        op: Literal["readdir", "listxattr"],
        path: str | PathSpec,
        session_id: str | None = None,
        **kwargs: Any,
    ) -> list[str]: ...

    @overload
    async def _call(
        self,
        op: Literal["readlink"],
        path: str | PathSpec,
        session_id: str | None = None,
        **kwargs: Any,
    ) -> str: ...

    @overload
    async def _call(
        self,
        op: Literal["setattr"],
        path: str | PathSpec,
        session_id: str | None = None,
        **kwargs: Any,
    ) -> dict[str, int | str]: ...

    @overload
    async def _call(
        self,
        op: str,
        path: str | PathSpec,
        session_id: str | None = None,
        **kwargs: Any,
    ) -> Any: ...

    async def _call(
        self,
        op: str,
        path: str | PathSpec,
        session_id: str | None = None,
        **kwargs: Any,
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
        timer = OpTimer(self._clock)
        report = OpReport()
        seen: list[str] = []
        # Only a line this workspace runs is joined: another workspace's
        # line, or another call's own recorder seen through a shared
        # browser stack, would take this workspace's records.
        line = active_recorder()
        own = (
            None
            if line is not None and line.ledger is self._records
            else fresh_recorder(clock=self._clock)
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
        if (
            op == "write" and kwargs.get("admit_only")
        ) or "retained" in kwargs:
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
        owner = self._reader().owner(ran)
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

    @overload
    async def read(
        self,
        path: str | PathSpec,
        offset: int = 0,
        size: int | None = None,
        raw: bool = False,
        *,
        stream: Literal[False] = False,
        session_id: str | None = None,
    ) -> bytes: ...

    @overload
    async def read(
        self,
        path: str | PathSpec,
        offset: int = 0,
        size: int | None = None,
        raw: bool = False,
        *,
        stream: Literal[True],
        session_id: str | None = None,
    ) -> AsyncIterator[bytes]: ...

    @overload
    async def read(
        self,
        path: str | PathSpec,
        offset: int = 0,
        size: int | None = None,
        raw: bool = False,
        *,
        stream: bool,
        session_id: str | None = None,
    ) -> bytes | AsyncIterator[bytes]: ...

    async def read(
        self,
        path: str | PathSpec,
        offset: int = 0,
        size: int | None = None,
        raw: bool = False,
        *,
        stream: bool = False,
        session_id: str | None = None,
    ) -> bytes | AsyncIterator[bytes]:
        """Read file content, whole or as the caller pulls it.

        ``stream`` answers with an async iterator: its first chunk is
        read before this returns, so a missing file fails here rather
        than at the first pull, a cold read fills the cache as it is
        pulled, and the read is recorded once the stream ends. A read the
        dispatcher answers whole (a window, a warm copy, a rendering, a
        backend answering bytes) arrives as one chunk.

        ``raw`` asks for the stored bytes, skipping a filetype-scoped
        read op the mount registers for this extension and the file
        cache a command's rendered read may have filled. Read-modify-
        write is what needs it: the merged buffer goes back through
        ``write``, which stores, so reading the rendering would store
        the rendering over the file. TypeScript spells the same thing
        ``read(path, {raw: true})``.

        Args:
            path (str | PathSpec): Virtual path.
            offset (int): Byte offset for range reads.
            size (int | None): Number of bytes for range reads.
            raw (bool): Read stored bytes rather than a rendered form.
            stream (bool): Answer with an async iterator of the bytes.
            session_id (str | None): Session to run as outside a line.

        Returns:
            bytes | AsyncIterator[bytes]: File content, streamed when
            ``stream`` asks for it.
        """
        kwargs: dict[str, Any] = {"filetype": None} if raw else {}
        if offset or size is not None:
            kwargs.update(offset=offset, size=size)
        if not stream:
            return cast(
                bytes, await self._call("read", path, session_id, **kwargs)
            )
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
    the network/cache split derived from it), and the mount questions
    FUSE and the runtime's ``open()`` interception ask
    (``unsized_mounts``, ``writable_mounts``, ``is_mounted``), answered
    from the namespace's live mount table. The
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
        for m in self._reader().shown():
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
        for m in self._reader().shown():
            if root and not (
                m.prefix.rstrip("/") == root or m.prefix.startswith(root + "/")
            ):
                continue
            if m.mode is not MountMode.READ:
                found.append((m.prefix, m.resource_type))
        return found

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
        rows = self._reader().rows()
        return (
            owner_prefix((m.prefix for m in rows if not m.anchor), path)
            is not None
        )


def reader_of(files: Files) -> NamespaceReader:
    """The namespace as the session a command's files run as sees it,
    for the helpers that walk it (``NamespaceReader``); outside a
    workspace, no link and no mount.

    The dispatcher's reader, never one of the facade's own: the link and
    mount tables are the dispatcher's, and the reader filters every
    answer by the rule the dispatcher refuses a call by.

    Args:
        files (Files): the session's files.
    """
    return files._reader()


async def path_mode(
    files: Files, path: str, follow: bool = True
) -> MountMode | None:
    """The mode a write at ``path`` meets, for the session ``files`` runs
    as (``effective_path_mode``): asked under the binding its ops run
    under, so a default session's profile counts, at the path a link
    leads to, where the write lands. None where no mount owns it.

    Args:
        files (Files): the session's files.
        path (str): absolute virtual path.
        follow (bool): whether a link at the final name is followed.
    """

    async def mode() -> MountMode | None:
        reader = files._reader()
        virtual = reader.follow(path) if follow else reader.follow_parent(path)
        owner = reader.owner(virtual)
        if owner is None:
            return None
        return effective_path_mode(virtual, owner.prefix, owner.mode)

    if files._bind is None:
        return await mode()
    return await files._bind(files._session_id, mode)


def operands_of(files: Files) -> FollowOperands | None:
    """The line's operand resolution a command's globs give their
    matches, which a command's files carry; None outside a line.

    Args:
        files (Files): the command's files.
    """
    return files._follow
