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
import weakref
from collections import OrderedDict, deque
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Iterator,
    Mapping,
    Sequence,
)
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from itertools import takewhile
from typing import Any, cast

from mirage.commands.builtin.generic_bind.dispatch import caller_stream
from mirage.commands.builtin.utils.links import (
    crosses_mounts,
    follow_of,
    link_location,
    links_of,
    mount_root,
    mount_view,
    mounts_of,
    owed_names,
)
from mirage.commands.builtin.utils.paths import is_implicit_dir
from mirage.commands.builtin.utils.tree import ReadTree
from mirage.commands.config import Context
from mirage.context import session_visibility
from mirage.context.session_context import awaits_as, current_caller
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import eacces, eisdir, enoent
from mirage.errors.types import DotWalkError, WalkDeclinedError
from mirage.io.cooperative import chunks
from mirage.io.stream import close_quietly, ensure_stream
from mirage.io.types import ByteSource, IOResult
from mirage.observe.context import revision_for
from mirage.runtime.types import DispatchFn
from mirage.types import (
    FileStat,
    FileType,
    PathSpec,
    ReaddirFn,
    ReadStreamFn,
    SetAttrFields,
    StatFn,
)
from mirage.utils.glob_walk import ResolveGlobFn, make_resolve_glob
from mirage.utils.hidden import move_reveals
from mirage.utils.path import CycleError
from mirage.view.types import MountView, SessionAccess
from mirage.workspace.dispatcher.read_batch import READ_AHEAD_BYTES, ReadBatch

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CommandFiles:
    """A command's files, path-first, every call sent to the dispatcher
    through the session's files (``ctx.vfs``).

    The dispatcher checks hides, the command's path rule, the mount's
    mode and policy, refuses a read of a directory and a write to a
    slash-terminated name, serves a warm copy and fills a cold one, fills
    a stat's unknown size from the read cache, gives way to the read for
    a file the read cache holds where a call stands in for one, settles a
    write's caches and receipt under its name's hold, and declines a
    one-call walk (a subtree read, search, a tree copy or removal) whose
    subtree the caller's view restricts, so a command's call answers
    what the same call through ``ws.vfs`` or FUSE answers. A function the
    mount's VFS does not answer is the dispatcher's ENOTSUP; a command
    asks ``answers`` before it takes a shortcut.

    Args:
        stat (StatFn): the entry at a path itself, as lstat answers.
        exists (Callable): whether an entry is at a path.
        readdir (ReaddirFn): ``readdir(path, nofollow=False)``.
        read (ReadStreamFn): ``read(path, offset=0, size=None)``, the
            stored bytes or a window of them, opened at the first pull;
            ``materialize`` collects them.
        is_warm (Callable): whether the read cache holds a copy a read
            would be served from; it fetches neither the copy nor
            anything from the backend.
        write (Callable): ``write(path, data)``.
        append (Callable): ``append(path, data)``.
        pwrite (Callable): ``pwrite(path, data, offset)``.
        mkdir (Callable): ``mkdir(path, parents=False)``.
        unlink (Callable): ``unlink(path)``.
        rmdir (Callable): ``rmdir(path)``.
        rm_r (Callable): ``rm_r(path)``.
        rename (Callable): ``rename(src, dst)``.
        copy (Callable): ``copy(src, dst)``.
        dir_copy (Callable): ``dir_copy(src, dst)``.
        truncate (Callable): ``truncate(path, length, no_create=False)``;
            ``no_create`` requires an atomic existence precondition, or
            ENOTSUP before writing.
        set_attrs (Callable): ``set_attrs(path, fields)``.
        first_lines (Callable): the first ``n`` lines; None when the file
            is to be read, as it is when the read cache holds it.
        last_lines (Callable): the last ``n`` lines; None when the file
            is to be read.
        line_count (Callable): how many lines the file holds; None when
            it is to be read.
        checksum (Callable): the digest the backend keeps; None when the
            file is to be read and hashed.
        follow (Callable): the last ``n`` lines, then the lines added;
            None when the file is to be polled.
        read_tree (Callable): every entry under a path, keyed below it;
            None when the directory is to be walked.
        files_containing (Callable): the files under a path that may
            contain ``text``; None when the search cannot answer for
            every file.
        lines_containing (Callable): the lines of a path that may contain
            ``text``; None when the search cannot answer for this file.
        resolve_glob (ResolveGlobFn): expand glob operands, a typed word
            as bash would.
        answers (Callable[[str], bool]): whether the mount the command
            runs on, whatever routed it there (an operand, an option, the
            working directory), answers a function itself, as the mount
            view says: where it does not, a shortcut is not taken.
    """

    stat: StatFn
    exists: Callable[[PathSpec], Awaitable[bool]]
    readdir: ReaddirFn
    read: ReadStreamFn
    is_warm: Callable[[PathSpec], Awaitable[bool]]
    write: Callable[[PathSpec, ByteSource], Awaitable[None]]
    append: Callable[[PathSpec, ByteSource], Awaitable[None]]
    pwrite: Callable[[PathSpec, ByteSource, int], Awaitable[None]]
    mkdir: Callable[..., Awaitable[None]]
    unlink: Callable[[PathSpec], Awaitable[None]]
    rmdir: Callable[[PathSpec], Awaitable[None]]
    rm_r: Callable[[PathSpec], Awaitable[None]]
    rename: Callable[[PathSpec, PathSpec], Awaitable[None]]
    copy: Callable[[PathSpec, PathSpec], Awaitable[None]]
    dir_copy: Callable[[PathSpec, PathSpec], Awaitable[None]]
    truncate: Callable[..., Awaitable[None]]
    set_attrs: Callable[
        [PathSpec, SetAttrFields], Awaitable[dict[str, int | str]]
    ]
    first_lines: Callable[[PathSpec, int], Awaitable[bytes | None]]
    last_lines: Callable[[PathSpec, int], Awaitable[bytes | None]]
    line_count: Callable[[PathSpec], Awaitable[int | None]]
    checksum: Callable[[PathSpec, str], Awaitable[str | None]]
    follow: Callable[
        [PathSpec, int, float], Awaitable[AsyncIterator[bytes] | None]
    ]
    read_tree: ReadTree
    files_containing: Callable[..., Awaitable[list[PathSpec] | None]]
    lines_containing: Callable[..., Awaitable[ByteSource | None]]
    resolve_glob: ResolveGlobFn
    answers: Callable[[str], bool]


@dataclass(frozen=True)
class Reading:
    """What the factory says of one invocation of a generic builder.

    Args:
        split (bool): an operand's read is cut into pieces; a
            pass-through builder (cat, head) keeps the producer's chunks.
        stream (Callable | None): what streams an operand in place of the
            dispatched read, given the invocation's context and the
            path; None, or an answer of None, keeps the dispatched read.
    """

    split: bool
    stream: (
        Callable[[Context, PathSpec], AsyncIterator[bytes] | None] | None
    ) = None


_READINGS: ContextVar[Reading | None] = ContextVar(
    "mirage_command_reading", default=None
)


@contextmanager
def with_reading(ctx: Context, reading: Reading) -> Iterator[Context]:
    """``ctx`` as the factory hands it to a builder, its files read as
    ``reading`` says, for the run inside the block.

    Args:
        ctx (Context): the invocation's context.
        reading (Reading): how the builder's files read.
    """
    token = _READINGS.set(reading)
    try:
        yield ctx
    finally:
        _READINGS.reset(token)


# The writes a run across mounts makes at the dispatcher, whichever mount
# serves the path; of the other functions it takes only ``read_tree``'s
# shortcut, where no mount sits below the subtree.
_CROSSING_CALLS = frozenset({"write", "pwrite", "unlink", "mkdir", "truncate"})

# How many files a whole read warms ahead of itself (``ReadAhead``).
READ_AHEAD = 8

# How many files a whole read reads ahead on a mount that holds its data
# locally, whose bytes the read-ahead hands over (``ReadBatch``).
READ_AHEAD_HELD = 64

# The options of a read a held file answers: the whole stored bytes,
# whether streamed or not.
_HELD_OPTIONS = frozenset({"stream", "filetype", "offset", "size"})

# How many of a command's latest listings its reads are matched against.
LISTINGS = 16


@dataclass(slots=True)
class _Run:
    """Files a command reads in turn: its operands, or the files of one
    directory as a listing or subtree answer named them. ``sent`` is
    where the next batch starts, ``latest`` how many files the batch
    before it took, ``last`` where the latest read was and ``rows`` what
    a subtree answer holds at each name."""

    names: list[str]
    sent: int = 0
    latest: int = 0
    last: int | None = None
    order: dict[str, int] | None = None
    warming: dict[str, asyncio.Future[ReadBatch]] = field(default_factory=dict)
    rows: Mapping[str, FileStat] | None = None

    def at(self, virtual: str) -> int | None:
        if self.order is None:
            self.order = {name: i for i, name in enumerate(self.names)}
        return self.order.get(virtual)


@dataclass(slots=True)
class _Tree:
    """A subtree answer and, once a read lands below it, its files
    grouped by directory, each keyed by its path below ``root``."""

    root: str
    rows: Mapping[str, FileStat]
    groups: dict[str, list[str]] | None = None


class ReadAhead:
    """What a command's whole reads warm ahead of themselves.

    A command reads files in turn: its operands, each whole once the one
    before is done, or the files a walk lists, a directory at a time. On
    a whole read of one, the files after it in its run go to the
    dispatcher as one ``read_many``, which keeps the small files among
    them in the read cache (one request where the store reads a batch),
    and the batch after goes once half of that one is read. Operands warm
    ``READ_AHEAD`` at a time. A walk warms as it shows it reads what it
    lists: one file once it reads two in a row, twice as many each time
    a read lands on a warmed file, up to ``READ_AHEAD``, and none once
    it passes over files it warmed, so a walk that reads few of the
    files it lists (a name filter) fetches few it never reads; the pace
    reads on warmed files set carries into the next directory, and a walk
    that reads in a directory has passed over what it warmed and never
    read in each one neither it nor above it. A read whose file is still being
    warmed waits for it, so it is served warm instead of fetching the
    file again; a write in between drops the cached copy as it drops any.
    A path in neither the operands nor the latest ``LISTINGS`` listings
    and subtree answers warms nothing.

    On a mount that holds its data locally there is no read cache to
    warm: the dispatcher reads the files for the command past each one's
    checks and hands their bytes back (``ReadBatch``), and each whole
    read of one is answered from them, once, while no change has reached
    the file since. Until a batch has said the mount holds its data, each
    asks the dispatcher to read nothing there, so a command that stops
    after its first file (``cat a b | head -n 1``) opens no other; the
    read that lands on such a batch reads ahead from itself instead.
    There a read reads ahead up to ``READ_AHEAD_HELD`` files, the file
    being read among them, so a directory's first file is no read of its
    own, and no more than the sizes it knows fit in ``READ_AHEAD_BYTES``;
    the batch after goes once half of that one is read, so a run holds at
    most two at a time; no file is in two batches.

    It sits in the command's dispatcher (``dispatch``), which every
    whole read, listing and subtree read of the command goes through.

    Args:
        dispatch (DispatchFn): the command's dispatcher.
        paths (Sequence[PathSpec]): its operands as typed; the names
            each glob resolves to follow them in the order resolved.
    """

    def __init__(self, dispatch: DispatchFn, paths: Sequence[PathSpec]):
        self.inner = dispatch
        self.operands = _Run([], sent=1, order={})
        self.specs: dict[str, PathSpec] = {}
        self.stats: dict[str, FileStat] = {}
        self.runs: OrderedDict[str, _Run] = OrderedDict()
        self.trees: deque[_Tree] = deque(maxlen=LISTINGS)
        self.width = 0
        self.kept = True
        self.holding = False
        self.unheld: weakref.WeakSet[asyncio.Future[ReadBatch]] = (
            weakref.WeakSet()
        )
        self.walked: _Run | None = None
        self.noted(list(paths))

    def noted(self, found: list[PathSpec]) -> None:
        """Learn the operands a glob resolved to, in order.

        Args:
            found (list[PathSpec]): the operands.
        """
        run = self.operands
        for path in found:
            if path.pattern is None and path.virtual not in self.specs:
                self.specs[path.virtual] = path
                cast(dict[str, int], run.order)[path.virtual] = len(run.names)
                run.names.append(path.virtual)

    async def dispatch(
        self, name: str, path: PathSpec, /, **options: Any
    ) -> tuple[Any, IOResult]:
        """The command's dispatcher: a whole read first reads ahead what
        follows it and is answered from a batch that holds it, and a
        listing or subtree read is learned as the order the command's walk
        reads its files in.

        Args:
            name (str): the op.
            path (PathSpec): the path it names.
            **options: the op's own arguments, its report among them.
        """
        if (
            name == "read"
            and not options.get("offset")
            and options.get("size") is None
            and not options.get("warm")
        ):
            held = await self._warmed(
                path,
                options.keys() <= _HELD_OPTIONS
                and options.get("filetype") is None,
            )
            if held is not None:
                return held, IOResult()
        result, io = await self.inner(name, path, **options)
        if not self.kept:
            return result, io
        folder = path.virtual.rstrip("/") or "/"
        if name == "stat" and path.virtual in self.specs:
            if isinstance(result, FileStat):
                self.stats[path.virtual] = result
        elif name == "readdir" and isinstance(result, list):
            files = [n for n in result if not n.endswith("/")]
            self._keep(folder, _Run(files))
        elif name == "read_tree" and isinstance(result, Mapping):
            self.trees.append(_Tree(folder, result))
        return result, io

    async def _warmed(self, path: PathSpec, served: bool) -> bytes | None:
        """Read ahead what follows ``path`` in its run, then wait for
        ``path`` itself while a batch is fetching it, and answer it from
        that batch while ``served``; None leaves the read to make. A
        batch that neither warmed nor held a file ends the command's
        read-ahead.

        Args:
            path (PathSpec): the file a whole read names.
            served (bool): whether a held file may answer the read.
        """
        run = self._run(path.virtual)
        at = None if run is None else run.at(path.virtual)
        if run is None or at is None:
            return None
        pending = run.warming.pop(path.virtual, None)
        if pending is not None and self.holding and pending in self.unheld:
            self._unhold(run, at)
            pending = None
        if run is not self.operands:
            self._entered(run, path.virtual.rpartition("/")[0] or "/")
        width = (
            (READ_AHEAD_HELD if self.holding else READ_AHEAD)
            if run is self.operands
            else self._paced(run, at, pending is not None)
        )
        start = max(
            run.sent, at if self.holding and pending is None else at + 1
        )
        ahead = min(width, run.latest or width) if self.holding else width
        if (
            self.kept
            and width
            and start < len(run.names)
            and start - at <= max(1, ahead // 2)
        ):
            rows = run.rows or {}
            found = {
                n: row
                for n in run.names[start : start + width]
                if (row := self.stats.get(n) or rows.get(n)) is not None
            }
            names = list(
                takewhile(
                    lambda n: n not in run.warming,
                    run.names[start : start + width],
                )
            )
            if self.holding:
                names = _fitting(names, found)
            run.sent = start + len(names)
            while (
                run.sent < len(run.names)
                and run.names[run.sent] in run.warming
            ):
                run.sent += 1
            if names:
                run.latest = len(names)
                specs = [
                    self.specs.get(n) or PathSpec.from_str_path(n)
                    for n in names
                ]
                stats = {n: found[n] for n in names if n in found}
                task = asyncio.ensure_future(
                    _warm(self.inner, specs, stats, self.holding)
                )
                if not self.holding:
                    self.unheld.add(task)
                for name in names:
                    run.warming[name] = task
                if start == at:
                    pending = run.warming.pop(path.virtual)
        if pending is None:
            return None
        batch = await asyncio.shield(pending)
        if not batch.kept and not batch.holds:
            self.kept = False
            self.trees.clear()
            return None
        if batch.holds:
            self.holding = True
            if pending in self.unheld:
                self._unhold(run, at)
                return await self._warmed(path, served)
        return batch.take(path.virtual) if served else None

    def _unhold(self, run: _Run, at: int) -> None:
        """Forget what ``run`` sent before the command knew its mount holds
        its data, which holds nothing there, so the read at ``at`` reads
        ahead from itself; a file another batch is reading stays with it.

        Args:
            run (_Run): the run of the read.
            at (int): where the read is in it.
        """
        for name in [
            n for n, task in run.warming.items() if task in self.unheld
        ]:
            del run.warming[name]
        run.sent = min(run.sent, at)

    def _paced(self, run: _Run, at: int, hit: bool) -> int:
        """How many files a walk's read at ``at`` warms: twice the pace on
        a warmed file, none past warmed files it passed over, at least one
        when two reads in a row are neighbours, else the pace it had. Only
        a read on a warmed file sets the pace later reads start from, in
        this directory or the next."""
        last, run.last = run.last, at
        passed = [n for n in run.warming if cast(int, run.at(n)) < at]
        for name in passed:
            del run.warming[name]
        if hit:
            self.width = min(
                READ_AHEAD_HELD if self.holding else READ_AHEAD,
                max(1, self.width) * 2,
            )
        elif passed:
            self.width = 0
        elif last is not None and at == last + 1:
            return max(1, self.width)
        return self.width

    def _entered(self, run: _Run, folder: str) -> None:
        """Note the directory a walk's read lands in. A walk reads what is
        in and below a directory before it goes on, so once it reads in
        another one it is done with every listed directory that is neither
        that one nor above it: what their runs warmed and it never read is
        passed over, and their runs are the first to go.

        Args:
            run (_Run): the run of the read.
            folder (str): the directory it lands in.
        """
        if self.walked is run:
            return
        self.walked = run
        passed = False
        for listed, kept in self.runs.items():
            if folder == listed or folder.startswith(listed.rstrip("/") + "/"):
                continue
            if kept.warming:
                kept.warming.clear()
                passed = True
        if passed:
            self.width = 0

    def _keep(self, folder: str, run: _Run) -> _Run:
        """Keep ``run`` as the latest of the ``LISTINGS`` runs, dropping
        the oldest one no batch is reading ahead for: a walk that went
        down into a directory comes back to its parent's files, which a
        batch may hold already."""
        self.runs[folder] = run
        self.runs.move_to_end(folder)
        if len(self.runs) > LISTINGS:
            older = list(self.runs.items())[:-1]
            idle = next((f for f, r in older if not r.warming), older[0][0])
            del self.runs[idle]
        return run

    def _run(self, virtual: str) -> _Run | None:
        """The run a path is read in: the operands, its directory's
        listing, or that directory's files as a subtree answer holds
        them."""
        if virtual in self.specs:
            return self.operands
        folder = virtual.rpartition("/")[0] or "/"
        run = self.runs.get(folder)
        if run is not None:
            self.runs.move_to_end(folder)
            return run
        for tree in reversed(self.trees):
            base = tree.root.rstrip("/") + "/"
            if folder != tree.root and not folder.startswith(base):
                continue
            if tree.groups is None:
                tree.groups = {}
                for key, row in tree.rows.items():
                    if row.type is not FileType.DIRECTORY:
                        above = key.rpartition("/")[0]
                        tree.groups.setdefault(above, []).append(key)
            rel = "" if folder == tree.root else folder[len(base) :]
            below = sorted(tree.groups.get(rel, []))
            return self._keep(
                folder,
                _Run(
                    [base + key for key in below],
                    rows={base + key: tree.rows[key] for key in below},
                ),
            )
        return None


def _fitting(names: list[str], rows: Mapping[str, FileStat]) -> list[str]:
    """The first of ``names`` whose sizes, where ``rows`` knows them, fit
    in what one held batch reads (``READ_AHEAD_BYTES``); at least one.

    Args:
        names (list[str]): the files, in the order they are read.
        rows (Mapping[str, FileStat]): what the command found at them.
    """
    room = READ_AHEAD_BYTES
    for i, name in enumerate(names):
        row = rows.get(name)
        size = (row.size or 0) if row is not None else 0
        if i and size > room:
            return names[:i]
        room -= size
    return names


async def _warm(
    dispatch: DispatchFn,
    paths: list[PathSpec],
    stats: dict[str, FileStat],
    hold: bool,
) -> ReadBatch:
    """Ask the dispatcher to read ``paths`` ahead: kept in the read cache,
    or held for the command where their mount holds its data locally and
    ``hold`` says to.

    A failure is logged and dropped: each read that follows meets it, and
    the read-ahead goes on.

    Args:
        dispatch (DispatchFn): the command's dispatcher.
        paths (list[PathSpec]): the files, at least one.
        stats (dict[str, FileStat]): what the command's stats and listings
            found at them, which size a file no index holds.
        hold (bool): whether to read the files on a mount that holds its
            data locally, or only learn whether theirs does.
    """
    try:
        batch, _ = await dispatch(
            "read_many", paths[0], paths=paths[1:], stats=stats, hold=hold
        )
    except Exception as exc:
        logger.debug("read-ahead from %s failed: %s", paths[0], exc)
        return ReadBatch(kept=True)
    if not isinstance(batch, ReadBatch):
        return ReadBatch(kept=True)
    return batch


async def dispatched_call(
    dispatch: DispatchFn, name: str, path: PathSpec, /, **kwargs: Any
) -> Any:
    """Send one call to the dispatcher and hand back its answer.

    The one way a command's file call, a cross-mount run and a relayed
    command reach a mount: the dispatcher finds the mount and judges the
    call on its way there.

    Args:
        dispatch (DispatchFn): the command's dispatcher.
        name (str): the dispatcher function.
        path (PathSpec): the path it acts on.
        **kwargs: the function's own keywords.
    """
    result, _ = await dispatch(name, path, **kwargs)
    return result


def dispatched_read_tree(
    dispatch: DispatchFn,
    mounts: MountView | None,
    landing: Callable[[str], str] | None,
    crossing: bool,
) -> ReadTree:
    """The ``read_tree`` a walk through the dispatcher takes, asked only
    where the mount a subtree lands on answers one; elsewhere None, and
    the walk lists instead.

    The serving mount's answer is no guide: a walk through the
    dispatcher also reaches the mounts below it and those a link above
    the subtree leads to, so a subtree on one that answers no read_tree
    (a disk mount under the root RAM) is walked rather than refused with
    ENOTSUP. A walk across mounts asks only where no mount sits below
    the subtree either: the serving backend's answer holds keys a mount
    there shadows, and lacks the mount's own. A subtree read stops at a
    link at the final name (ENOTDIR), so a walk that follows links
    lists them directory by directory instead. One level (``level=True``)
    is the listing a ``readdir`` answers with each child's stat, which
    every mount that keeps listings answers, asked only where no mount
    sits below, whose root the listing would name.

    Args:
        dispatch (DispatchFn): the walk's dispatcher.
        mounts (MountView | None): the mount boundaries, as a walk that
            does not cross them sees them (``mount_view(files)``); None
            takes no shortcut.
        landing (Callable[[str], str] | None): where a path lands, every
            link above its final name followed (``link_location``,
            ``NamespaceLinks.follow_parent``); None for a walk whose
            paths name their own place.
        crossing (bool): the walk crosses mounts (``crosses_mounts``).
    """

    async def read_tree(
        path: PathSpec, limit: int | None = None, level: bool = False
    ) -> dict[str, FileStat] | None:
        try:
            at = path.virtual if landing is None else landing(path.virtual)
        except CycleError as exc:
            logger.debug(
                "following the links above %s failed: %s", path.virtual, exc
            )
            return None
        if (
            mounts is None
            or (
                not level
                and mounts.answers is not None
                and not mounts.answers(at, "read_tree")
            )
            or ((crossing or level) and bool(mounts.descendants(at)))
        ):
            return None
        return cast(
            dict[str, FileStat] | None,
            await dispatched_call(
                dispatch,
                "read_tree",
                path,
                nofollow=True,
                **({} if limit is None else {"limit": limit}),
                **({"level": True} if level else {}),
            ),
        )

    return read_tree


async def _dispatched_stream(
    dispatch: DispatchFn,
    path: PathSpec,
    offset: int = 0,
    size: int | None = None,
) -> AsyncIterator[bytes]:
    """A command's streamed read of the stored bytes, or a window of
    them, at the dispatcher, opened at the first pull, as a backend
    stream is.

    Args:
        dispatch (DispatchFn): the command's dispatcher.
        path (PathSpec): the file.
        offset (int): first byte of the window.
        size (int | None): window length, None for the rest.
    """
    data, _ = await dispatch(
        "read", path, stream=True, filetype=None, offset=offset, size=size
    )
    source = ensure_stream(data)
    try:
        async for chunk in source:
            yield chunk
    finally:
        await close_quietly(source)


async def _dispatched_stat(dispatch: DispatchFn, path: PathSpec) -> FileStat:
    """A command's stat of the entry at ``path``, at the dispatcher.

    The entry itself, as lstat answers, so a link at the final name is
    the link and a trailing slash reaches what it names. The dispatcher
    merges the namespace's overlay into the row.

    Args:
        dispatch (DispatchFn): the command's dispatcher.
        path (PathSpec): the path.
    """
    found, _ = await dispatch("stat", path, nofollow=True)
    if not isinstance(found, FileStat):
        raise enoent(path)
    return found


async def _dispatched_exists(dispatch: DispatchFn, path: PathSpec) -> bool:
    """Whether an entry is at ``path``, as ``_dispatched_stat`` answers.

    Args:
        dispatch (DispatchFn): the command's dispatcher.
        path (PathSpec): the path.
    """
    try:
        await _dispatched_stat(dispatch, path)
    except FileNotFoundError as exc:
        logger.debug("nothing at %s: %s", path.virtual, exc)
        return False
    return True


def _is_namespace_dir(ctx: Context, path: PathSpec) -> bool:
    """Whether a path no backend knows is a directory the namespace owns.

    The third way a read operand can be a directory, after the explicit
    stat row and the implicit keyed-backend prefix. A directory that
    exists only because a mount or a link sits under it (``/repos`` when
    ``/repos/alpha`` is mounted) belongs to no backend at all, so the
    mount this command runs on can neither stat it nor list it, and every
    read command reported it missing while stat, file, ls, du, find and
    tree all called it a directory.

    The names the namespace owes the path, not a dispatched stat. Both
    answer for a mount parent, but a dispatched stat also answers from a
    backend's own listing, and a backend that answers a path it does not
    hold with entries rather than a miss turns every such path into a
    directory: postgres reads any first segment as a schema and lists
    ``tables`` and ``views`` under it, so ``cat /pg/nope.txt`` refused a
    directory that is not there. The namespace cannot over-claim that
    way, because it derives a segment only from a mount prefix or a link
    path it actually holds, and it is the same authority
    ``namespace_listing`` gates on, so the listing and this refusal
    cannot disagree. It is hide-filtered for free, which is what keeps
    the parent of a mount the session may not be told about reading as
    absence.

    Args:
        ctx (Context): the invocation's context, for its files.
        path (PathSpec): the operand whose stat raised ENOENT.
    """
    return bool(owed_names(ctx.vfs, path.virtual))


async def _stat_refusing_dirs(
    files: CommandFiles, ctx: Context, path: PathSpec
) -> FileStat:
    """The one place the read family decides what a directory is, shared
    by the stat and the stream chokepoints so the two cannot drift.

    Args:
        files (CommandFiles): the command's files.
        ctx (Context): the invocation's context.
        path (PathSpec): the operand.
    """
    try:
        st = await files.stat(path)
    except DotWalkError:
        raise
    except FileNotFoundError:
        if await is_implicit_dir(files.readdir, path):
            st = await _landed_or_dir(files, path)
        elif _is_namespace_dir(ctx, path):
            raise eisdir(path) from None
        else:
            raise
    if st.type == FileType.DIRECTORY:
        raise eisdir(path)
    return st


async def _landed_or_dir(files: CommandFiles, path: PathSpec) -> FileStat:
    """The stat of a file written between the stat that missed it and
    the listing that named it, which otherwise looks like a prefix of
    deeper keys, so ``echo hi > f &`` then ``cat f`` read the new file
    as a directory. A second stat tells the two apart: only a prefix
    misses again.

    Args:
        files (CommandFiles): the command's files.
        path (PathSpec): the operand the listing named.
    """
    try:
        return await files.stat(path)
    except FileNotFoundError:
        raise eisdir(path) from None


def dir_aware_stat(files: CommandFiles, ctx: Context) -> StatFn:
    """The read family's stat, ``stat(path)``, for ``split_readable``.

    A directory operand fails with EISDIR instead of succeeding
    (explicit, via the stat type) or failing with ENOENT (implicit
    keyed-backend directory via a readdir probe, or a namespace-only
    mount parent via the name plane), so cat/head/tail report GNU's
    ``Is a directory`` and keep the remaining operands (#457).

    Args:
        files (CommandFiles): the command's files.
        ctx (Context): the invocation's context.
    """

    async def stat(path: PathSpec) -> FileStat:
        return await _stat_refusing_dirs(files, ctx, path)

    return stat


def stat_size(
    files: CommandFiles,
) -> Callable[[PathSpec], Awaitable[int | None]]:
    """A regular file's size as its stat gives it, ``size(path)``, for a
    width GNU takes from ``st_size`` (``wc``'s columns). None for
    anything but a regular file, for a size the stat does not know, and
    for a path the stat refuses, which the command's own read reports.

    Args:
        files (CommandFiles): the command's files.
    """

    async def size(path: PathSpec) -> int | None:
        try:
            st = await files.stat(path)
        except FS_ERRORS as exc:
            logger.debug("%s: no size for a width: %s", path.virtual, exc)
            return None
        return st.size if st.type == FileType.FILE else None

    return size


def file_size(
    files: CommandFiles, ctx: Context, *, opened: bool = False
) -> Callable[[PathSpec], Awaitable[int | None]]:
    """A regular file's size from its stat, ``size(path)``, for a command
    whose answer is the size alone (``wc -c``), as GNU takes it from
    ``st_size``.

    None reads the file instead: for a file the read cache holds, which
    is read from there as the read it replaces would be; for anything
    but a regular file (a device or a pipe has no size to trust); for a
    size the stat does not know; for a path pinned to an older revision,
    whose size the stat does not give; and for a store that keeps
    permission bits (a disk, SFTP), where a file the stat sees may still
    refuse its read, and a disk's named pipe stats as a file. A store
    without them grants the read with the stat. A directory fails with
    EISDIR as ``dir_aware_stat`` has it. A listing the index holds can
    be up to its TTL old, so the size is checked against a stat that
    asks the backend now (``fresh``), and a file whose size moved since
    the listing is read: whether that read serves the listed version (a
    GitHub blob the listing named) or the current one, it is what the
    command counts.

    Args:
        files (CommandFiles): the command's files.
        ctx (Context): the invocation's context.
        opened (bool): the caller has opened the input, so permission bits
            do not preclude using a nonzero regular-file size.
    """

    reading = _READINGS.get()

    async def size(path: PathSpec) -> int | None:
        if reading is not None and reading.stream is not None:
            return None
        if opened and crosses_mounts(ctx):
            return None
        if revision_for(path.virtual) is not None:
            return None
        if await files.is_warm(path):
            return None
        st = await _stat_refusing_dirs(files, ctx, path)
        if (
            st.type != FileType.FILE
            or st.size is None
            or (st.mode is not None and (not opened or st.size == 0))
        ):
            return None
        if ctx.vfs is None:
            return st.size
        now, _ = await ctx.vfs.dispatch("stat", path, fresh=True)
        if not isinstance(now, FileStat) or now.size != st.size:
            return None
        return st.size

    return size


async def _stream_refusing_dirs(
    files: CommandFiles, ctx: Context, path: PathSpec
) -> AsyncIterator[bytes]:
    await _stat_refusing_dirs(files, ctx, path)
    async for chunk in files.read(path):
        yield chunk


def dir_aware_stream(files: CommandFiles, ctx: Context) -> ReadStreamFn:
    """The per-operand read stream, ``read(path)``, the read family takes.

    The operand is stat'ed first so a directory fails with EISDIR before
    any backend read runs (sftp reads of a directory raise an opaque
    ``Failure``, not ENOENT), and an ENOENT for an implicit keyed-backend
    directory or a namespace-only mount parent is refined the same way
    ``dir_aware_stat`` does, before the generic formats the stderr line
    (#457).

    Args:
        files (CommandFiles): the command's files.
        ctx (Context): the invocation's context.
    """

    def stream(path: PathSpec) -> AsyncIterator[bytes]:
        return _stream_refusing_dirs(files, ctx, path)

    return stream


async def resolve_or_empty(
    files: CommandFiles, paths: Sequence[PathSpec]
) -> list[PathSpec]:
    """Expand glob operands, or [] when there is nothing to resolve.

    No operand resolves to no paths, which the generics read as stdin
    mode. Operand semantics (report-and-continue, directory refusal) live
    in the generics via ``split_readable``; this is wiring only.

    Args:
        files (CommandFiles): the command's files.
        paths (Sequence[PathSpec]): Raw path operands (may hold globs).
    """
    if paths:
        return await files.resolve_glob(list(paths))
    return []


def refuse_reveal(
    src: PathSpec, dst: PathSpec, access: SessionAccess | None = None
) -> None:
    """Refuse a relocation that would surface a hidden path.

    A rename or a native directory copy re-anchors everything below its
    source, and a hide's coverage does not move with the content, so
    hidden bytes would land at paths the session can see. EACCES on the
    source, which mv and cp render in GNU's permission-denied voice.
    Only a directory has anything below it to re-anchor, so callers
    check this for a source they know is a directory and skip it for a
    file.

    Args:
        src (PathSpec): the subtree being moved or copied.
        dst (PathSpec): where it would land.
        access (SessionAccess | None): the session the command runs as,
            else the current one.
    """
    if move_reveals(session_visibility(access), src.virtual, dst.virtual):
        raise eacces(src.virtual)


def command_files(
    ctx: Context, paths: Sequence[PathSpec] = ()
) -> CommandFiles:
    """The files of the command ``ctx`` runs, its operands ``paths``.

    Every call goes to the dispatcher through ``ctx.vfs``, which refuses
    a read of a directory and a write to a slash-terminated name and
    fills a stat's unknown size from the read cache. A command on one
    mount reads the stored bytes (``filetype=None``), its whole reads
    warmed ahead of themselves (``ReadAhead``), and, as the factory
    hands it on (``with_reading``), each operand's read cut into pieces.
    A run across mounts (``crosses_mounts``) reads each operand as the
    command that asked for it, through the path's renderer, after a stat
    that refuses a directory, and lists with no boundary to stop at.

    Args:
        ctx (Context): the invocation's context.
        paths (Sequence[PathSpec]): the command's path operands.

    Raises:
        TypeError: the command ran outside a workspace, with no files to
            read.
    """
    vfs = ctx.vfs
    if vfs is None:
        name = ctx.spec.name if ctx.spec is not None else ""
        raise TypeError(f"{name}: no workspace files")
    ahead = ReadAhead(vfs.dispatch, paths)
    dispatch = ahead.dispatch
    crossing = crosses_mounts(ctx)
    reading = None if crossing else _READINGS.get()
    # What the mount can do is the serving mount's to say: an option can
    # route the command to it with no operand there (`shuf -i 1-1
    # -o /ram/out` typed on another mount).
    home = mount_root(ctx)
    anchor = home + "/"
    mounts = mounts_of(ctx)

    async def call(name: str, path: PathSpec, /, **kwargs: Any) -> Any:
        return await dispatched_call(dispatch, name, path, **kwargs)

    raw_stat: StatFn
    raw_readdir: ReaddirFn
    raw_stream: ReadStreamFn
    if crossing:
        # A run across mounts can hand its output on as it drains, after
        # its handler returned (``streams``): every call these files make
        # opens as the command that built them, whenever it is made.
        caller = current_caller()

        async def crossing_stat(path: PathSpec) -> FileStat:
            found, _ = await dispatch("stat", path, nofollow=True)
            return cast(FileStat, found)

        async def crossing_readdir(
            path: PathSpec, nofollow: bool = False, limit: int | None = None
        ) -> list[str]:
            entries, _ = await dispatch(
                "readdir", path, **({} if limit is None else {"limit": limit})
            )
            return cast(list[str], entries)

        def crossing_stream(path: PathSpec) -> AsyncIterator[bytes]:
            return caller_stream(dispatch, caller, path)

        raw_stat = awaits_as(caller, crossing_stat)
        raw_readdir = awaits_as(caller, crossing_readdir)
        raw_stream = crossing_stream
    else:

        async def stat_at(path: PathSpec) -> FileStat:
            return await _dispatched_stat(dispatch, path)

        async def readdir_at(
            path: PathSpec, nofollow: bool = False, limit: int | None = None
        ) -> list[str]:
            asked: dict[str, Any] = {} if limit is None else {"limit": limit}
            if nofollow:
                asked["nofollow"] = True
            return cast(list[str], await call("readdir", path, **asked))

        replaced = reading.stream if reading is not None else None

        def stream_at(path: PathSpec) -> AsyncIterator[bytes]:
            if replaced is not None:
                own = replaced(ctx, path)
                if own is not None:
                    return own
            return _dispatched_stream(dispatch, path)

        raw_stat = stat_at
        raw_readdir = readdir_at
        raw_stream = stream_at

    async def is_warm(path: PathSpec) -> bool:
        # A run across mounts runs in no mount's cache scope: it takes an
        # operand's size from its stat, warm or not.
        if crossing:
            return False
        held, _ = await dispatch("read", path, filetype=None, warm=True)
        return held is True

    def read(
        path: PathSpec, offset: int = 0, size: int | None = None
    ) -> AsyncIterator[bytes]:
        source = (
            raw_stream(path)
            if not offset and size is None
            else _dispatched_stream(dispatch, path, offset=offset, size=size)
        )
        return (
            chunks(source) if reading is not None and reading.split else source
        )

    table = links_of(ctx)
    links = None if crossing else table
    access = None if crossing or ctx.session is None else ctx.session.access()

    async def exists(path: PathSpec) -> bool:
        return await _dispatched_exists(dispatch, path)

    async def write(path: PathSpec, data: ByteSource) -> None:
        await call("write", path, data=data)

    async def append(path: PathSpec, data: ByteSource) -> None:
        await call("append", path, data=data)

    async def pwrite(path: PathSpec, data: ByteSource, offset: int) -> None:
        await call("pwrite", path, data=data, offset=offset)

    async def mkdir(path: PathSpec, parents: bool = False) -> None:
        await call("mkdir", path, parents=parents)

    async def unlink(path: PathSpec) -> None:
        await call("unlink", path)

    async def rmdir(path: PathSpec) -> None:
        await call("rmdir", path)

    async def rm_r(path: PathSpec) -> None:
        await call("rm_r", path)

    async def rename(src: PathSpec, dst: PathSpec) -> None:
        await call("rename", src, dst=dst)

    async def copy(src: PathSpec, dst: PathSpec) -> None:
        await call("copy", src, dst=dst)

    async def dir_copy(src: PathSpec, dst: PathSpec) -> None:
        await call("dir_copy", src, dst=dst)

    async def truncate(
        path: PathSpec, length: int, no_create: bool = False
    ) -> None:
        await call("truncate", path, length=length, no_create=no_create)

    async def set_attrs(
        path: PathSpec, fields: SetAttrFields
    ) -> dict[str, int | str]:
        return cast(
            dict[str, int | str], await call("setattr", path, **fields)
        )

    async def first_lines(path: PathSpec, n: int) -> bytes | None:
        return cast(bytes | None, await call("first_lines", path, n=n))

    async def last_lines(path: PathSpec, n: int) -> bytes | None:
        return cast(bytes | None, await call("last_lines", path, n=n))

    async def line_count(path: PathSpec) -> int | None:
        return cast(int | None, await call("line_count", path))

    async def checksum(path: PathSpec, algorithm: str) -> str | None:
        return cast(
            str | None, await call("checksum", path, algorithm=algorithm)
        )

    async def follow(
        path: PathSpec, n: int, interval: float
    ) -> AsyncIterator[bytes] | None:
        return cast(
            AsyncIterator[bytes] | None,
            await call("follow", path, n=n, interval=interval),
        )

    declined: tuple[str, str, bool, bool] | None = None

    async def files_containing(
        path: PathSpec,
        text: str,
        *,
        whole_word: bool,
        ignore_case: bool,
        prune: bool = False,
    ) -> list[PathSpec] | None:
        nonlocal declined
        if prune and (
            crossing or (reading is not None and reading.stream is not None)
        ):
            return None
        query = (path.virtual, text, whole_word, ignore_case)
        if query == declined:
            return None
        try:
            return cast(
                list[PathSpec] | None,
                await call(
                    "files_containing",
                    path,
                    text=text,
                    whole_word=whole_word,
                    ignore_case=ignore_case,
                    **({"prune": True} if prune else {}),
                ),
            )
        except WalkDeclinedError as exc:
            if not prune:
                raise
            logger.debug("grep candidate search declined: %s", exc)
            declined = query
            return None

    async def lines_containing(
        path: PathSpec, text: str, *, ignore_case: bool
    ) -> ByteSource | None:
        return cast(
            ByteSource | None,
            await call(
                "lines_containing", path, text=text, ignore_case=ignore_case
            ),
        )

    def answers(name: str) -> bool:
        if (
            name == "read_range"
            and reading is not None
            and reading.stream is not None
        ):
            return False
        if crossing:
            return name in _CROSSING_CALLS or name == "read_tree"
        return (
            mounts is not None
            and mounts.answers is not None
            and mounts.answers(anchor, name)
        )

    limit = (
        -1
        if mounts is None or mounts.walk_limit is None
        else mounts.walk_limit(anchor)
    )
    return CommandFiles(
        stat=raw_stat,
        exists=exists,
        readdir=raw_readdir,
        read=read,
        is_warm=is_warm,
        write=write,
        append=append,
        pwrite=pwrite,
        mkdir=mkdir,
        unlink=unlink,
        rmdir=rmdir,
        rm_r=rm_r,
        rename=rename,
        copy=copy,
        dir_copy=dir_copy,
        truncate=truncate,
        set_attrs=set_attrs,
        first_lines=first_lines,
        last_lines=last_lines,
        line_count=line_count,
        checksum=checksum,
        follow=follow,
        read_tree=dispatched_read_tree(
            dispatch,
            mount_view(vfs),
            None if table is None else functools.partial(link_location, table),
            crossing,
        ),
        files_containing=files_containing,
        lines_containing=lines_containing,
        resolve_glob=make_resolve_glob(
            raw_readdir,
            limit,
            raw_stat,
            links.target_stat if links is not None else None,
            access,
            follow_of(ctx),
            ahead.noted,
        ),
        answers=answers,
    )
