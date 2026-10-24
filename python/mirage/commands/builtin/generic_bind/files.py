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
from dataclasses import dataclass
from typing import Any, cast

from mirage.commands.builtin.generic_bind.dispatch import caller_stream
from mirage.commands.builtin.utils.links import (
    crosses_mounts,
    follow_of,
    link_location,
    links_of,
    mount_root,
    mounts_of,
    owed_names,
)
from mirage.commands.builtin.utils.paths import is_implicit_dir
from mirage.commands.config import Context
from mirage.context import session_visibility
from mirage.context.session_context import current_caller
from mirage.errors.fs import eacces, eisdir, enoent
from mirage.errors.types import DotWalkError
from mirage.io.cooperative import chunks
from mirage.io.stream import close_quietly, ensure_stream, materialize
from mirage.io.types import ByteSource
from mirage.observe.context import revision_for
from mirage.runtime.types import DispatchFn
from mirage.types import (
    FileStat,
    FileType,
    PathSpec,
    ReadBytesFn,
    ReaddirFn,
    ReadStreamFn,
    StatFn,
)
from mirage.utils.glob_walk import ResolveGlobFn, make_resolve_glob
from mirage.utils.hidden import move_reveals
from mirage.utils.path import CycleError
from mirage.view.types import SessionAccess

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
        read_bytes (ReadBytesFn): the stored bytes, whole.
        read_range (ReadBytesFn): ``read_range(path, offset, size)``.
        read_stream (ReadStreamFn): the stored bytes, opened at the
            first pull.
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
    read_bytes: ReadBytesFn
    read_range: ReadBytesFn
    read_stream: ReadStreamFn
    is_warm: Callable[[PathSpec], Awaitable[bool]]
    write: Callable[[PathSpec, ByteSource], Awaitable[None]]
    append: Callable[[PathSpec, ByteSource], Awaitable[None]]
    pwrite: Callable[[PathSpec, bytes, int], Awaitable[None]]
    mkdir: Callable[..., Awaitable[None]]
    unlink: Callable[[PathSpec], Awaitable[None]]
    rmdir: Callable[[PathSpec], Awaitable[None]]
    rm_r: Callable[[PathSpec], Awaitable[None]]
    rename: Callable[[PathSpec, PathSpec], Awaitable[None]]
    copy: Callable[[PathSpec, PathSpec], Awaitable[None]]
    dir_copy: Callable[[PathSpec, PathSpec], Awaitable[None]]
    truncate: Callable[..., Awaitable[None]]
    set_attrs: Callable[
        [PathSpec, Mapping[str, Any]], Awaitable[dict[str, int | str]]
    ]
    first_lines: Callable[[PathSpec, int], Awaitable[bytes | None]]
    last_lines: Callable[[PathSpec, int], Awaitable[bytes | None]]
    line_count: Callable[[PathSpec], Awaitable[int | None]]
    checksum: Callable[[PathSpec, str], Awaitable[str | None]]
    follow: Callable[
        [PathSpec, int, float], Awaitable[AsyncIterator[bytes] | None]
    ]
    read_tree: Callable[[PathSpec], Awaitable[Any]]
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
# serves the path; it takes no other function's shortcut.
_CROSSING_CALLS = frozenset({"write", "pwrite", "unlink", "mkdir", "truncate"})

# How many operands a whole read warms ahead of itself (``read_ahead``).
READ_AHEAD = 8


def read_ahead(
    dispatch: DispatchFn, paths: Sequence[PathSpec]
) -> tuple[
    Callable[[PathSpec], Awaitable[None]], Callable[[list[PathSpec]], None]
]:
    """What a command's whole read of an operand awaits first, and what
    learns the operands its globs resolve to.

    A command reads its operands in turn, each whole once the one before
    is done. On a whole read of one, the next ``READ_AHEAD`` go to the
    dispatcher as one ``read_many``, which keeps the small files among
    them in the read cache (one request where the store reads a batch),
    and the batch after goes once half of that one is read. A read whose
    file is still being warmed waits for it, so it is served warm instead
    of fetching the file again. No bytes are held here: a write in
    between drops the cached copy as it drops any. A path that is not an
    operand warms nothing.

    Args:
        dispatch (DispatchFn): the command's dispatcher.
        paths (Sequence[PathSpec]): its operands as typed; the names
            each glob resolves to follow them in the order resolved.
    """
    operands: list[PathSpec] = []
    order: dict[str, int] = {}
    warming: dict[str, asyncio.Future[None]] = {}
    sent = 1

    def noted(found: list[PathSpec]) -> None:
        for path in found:
            if path.pattern is None and path.virtual not in order:
                order[path.virtual] = len(operands)
                operands.append(path)

    async def warmed(path: PathSpec) -> None:
        nonlocal sent
        at = order.get(path.virtual)
        if at is None:
            return
        start = max(sent, at + 1)
        if start < len(operands) and start <= at + READ_AHEAD // 2:
            batch = operands[start : start + READ_AHEAD]
            sent = start + len(batch)
            task = asyncio.ensure_future(_warm(dispatch, batch))
            for p in batch:
                warming[p.virtual] = task
        pending = warming.get(path.virtual)
        if pending is not None:
            await asyncio.shield(pending)

    noted(list(paths))
    return warmed, noted


async def _warm(dispatch: DispatchFn, paths: list[PathSpec]) -> None:
    """Ask the dispatcher to keep ``paths`` in the read cache.

    A failure is logged and dropped: each read that follows meets it.

    Args:
        dispatch (DispatchFn): the command's dispatcher.
        paths (list[PathSpec]): the files, at least one.
    """
    try:
        await dispatch("read_many", paths[0], paths=paths[1:])
    except Exception as exc:
        logger.debug("read-ahead from %s failed: %s", paths[0], exc)


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


async def _dispatched_bytes(
    dispatch: DispatchFn,
    path: PathSpec,
    offset: int = 0,
    size: int | None = None,
    ahead: Callable[[PathSpec], Awaitable[None]] | None = None,
) -> bytes:
    """A command's whole or ranged read of the stored bytes, at the
    dispatcher.

    Args:
        dispatch (DispatchFn): the command's dispatcher.
        path (PathSpec): the file.
        offset (int): first byte of the window.
        size (int | None): window length, None for the rest.
        ahead (Callable[[PathSpec], Awaitable[None]] | None): what a
            whole read awaits first (``read_ahead``).
    """
    if ahead is not None and offset == 0 and size is None:
        await ahead(path)
    data, _ = await dispatch(
        "read", path, filetype=None, offset=offset, size=size
    )
    return await materialize(data) or b""


async def _dispatched_stream(
    dispatch: DispatchFn,
    path: PathSpec,
    ahead: Callable[[PathSpec], Awaitable[None]] | None = None,
) -> AsyncIterator[bytes]:
    """A command's streamed read of the stored bytes, at the dispatcher,
    opened at the first pull, as a backend stream is.

    Args:
        dispatch (DispatchFn): the command's dispatcher.
        path (PathSpec): the file.
        ahead (Callable[[PathSpec], Awaitable[None]] | None): what the
            read awaits first (``read_ahead``).
    """
    if ahead is not None:
        await ahead(path)
    data, _ = await dispatch("read", path, stream=True, filetype=None)
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
            raise eisdir(path) from None
        if _is_namespace_dir(ctx, path):
            raise eisdir(path) from None
        raise
    if st.type == FileType.DIRECTORY:
        raise eisdir(path)
    return st


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


def file_size(
    files: CommandFiles, ctx: Context
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
    """

    async def size(path: PathSpec) -> int | None:
        if revision_for(path.virtual) is not None:
            return None
        if await files.is_warm(path):
            return None
        st = await _stat_refusing_dirs(files, ctx, path)
        if st.type != FileType.FILE or st.mode is not None:
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
    async for chunk in files.read_stream(path):
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
    warmed ahead of themselves (``read_ahead``), and, as the factory
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
    dispatch = vfs.dispatch
    crossing = crosses_mounts(ctx)
    reading = None if crossing else _READINGS.get()
    # What the mount can do is the serving mount's to say: an option can
    # route the command to it with no operand there (`shuf -i 1-1
    # -o /ram/out` typed on another mount).
    home = mount_root(ctx)
    anchor = home + "/"
    mounts = mounts_of(ctx)
    ahead, noted = read_ahead(dispatch, paths)

    async def call(name: str, path: PathSpec, /, **kwargs: Any) -> Any:
        return await dispatched_call(dispatch, name, path, **kwargs)

    raw_stat: StatFn
    raw_readdir: ReaddirFn
    raw_bytes: ReadBytesFn
    raw_stream: ReadStreamFn
    if crossing:

        async def crossing_stat(path: PathSpec) -> FileStat:
            found, _ = await dispatch("stat", path, nofollow=True)
            return cast(FileStat, found)

        async def crossing_readdir(
            path: PathSpec, nofollow: bool = False
        ) -> list[str]:
            entries, _ = await dispatch("readdir", path)
            return cast(list[str], entries)

        async def rendered_bytes(path: PathSpec) -> bytes:
            info, _ = await dispatch("stat", path)
            if cast(FileStat, info).type == FileType.DIRECTORY:
                raise eisdir(path)
            await ahead(path)
            data, _ = await dispatch("read", path)
            return await materialize(data) or b""

        def crossing_stream(path: PathSpec) -> AsyncIterator[bytes]:
            return caller_stream(dispatch, current_caller(), path, ahead)

        raw_stat = crossing_stat
        raw_readdir = crossing_readdir
        raw_bytes = rendered_bytes
        raw_stream = crossing_stream
    else:

        async def stat_at(path: PathSpec) -> FileStat:
            return await _dispatched_stat(dispatch, path)

        async def readdir_at(
            path: PathSpec, nofollow: bool = False
        ) -> list[str]:
            if nofollow:
                return cast(
                    list[str], await call("readdir", path, nofollow=True)
                )
            return cast(list[str], await call("readdir", path))

        async def bytes_at(path: PathSpec) -> bytes:
            return await _dispatched_bytes(dispatch, path, ahead=ahead)

        replaced = reading.stream if reading is not None else None

        def stream_at(path: PathSpec) -> AsyncIterator[bytes]:
            if replaced is not None:
                own = replaced(ctx, path)
                if own is not None:
                    return own
            return _dispatched_stream(dispatch, path, ahead)

        raw_stat = stat_at
        raw_readdir = readdir_at
        raw_bytes = bytes_at
        raw_stream = stream_at

    async def raw_range(
        path: PathSpec, offset: int = 0, size: int | None = None
    ) -> bytes:
        return await _dispatched_bytes(dispatch, path, offset, size)

    async def is_warm(path: PathSpec) -> bool:
        # A run across mounts runs in no mount's cache scope: it takes an
        # operand's size from its stat, warm or not.
        if crossing:
            return False
        held, _ = await dispatch("read", path, filetype=None, warm=True)
        return held is True

    read_stream: ReadStreamFn = raw_stream
    if reading is not None and reading.split:

        def split_stream(path: PathSpec) -> AsyncIterator[bytes]:
            return chunks(raw_stream(path))

        read_stream = split_stream
    links = None if crossing else links_of(ctx)
    access = None if crossing or ctx.session is None else ctx.session.access()

    # Where a call that keeps its final name lands: every link above it
    # followed, as the dispatcher follows them. A loop is left to the call.
    def landing(virtual: str) -> str:
        if links is None:
            return virtual
        try:
            return link_location(links, virtual)
        except CycleError as exc:
            logger.debug(
                "following the links above %s failed: %s", virtual, exc
            )
            return virtual

    async def exists(path: PathSpec) -> bool:
        return await _dispatched_exists(dispatch, path)

    async def write(path: PathSpec, data: ByteSource) -> None:
        await call("write", path, data=data)

    async def append(path: PathSpec, data: ByteSource) -> None:
        await call("append", path, data=data)

    async def pwrite(path: PathSpec, data: bytes, offset: int) -> None:
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
        path: PathSpec, fields: Mapping[str, Any]
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

    # A subtree read stops at a link at the final name (ENOTDIR): it
    # cannot pass through one, so a walk that follows links lists them
    # directory by directory instead. ``answers`` speaks for the serving
    # mount, but a walk through the dispatcher also reaches the mounts
    # below it and those a link above the subtree leads to, so a subtree
    # on one that answers no read_tree (a disk mount under the root RAM)
    # is left to be walked rather than refused with ENOTSUP.
    async def read_tree(path: PathSpec) -> Any:
        if (
            not crossing
            and mounts is not None
            and mounts.answers is not None
            and not mounts.answers(landing(path.virtual), "read_tree")
        ):
            return None
        return await call("read_tree", path, nofollow=True)

    async def files_containing(
        path: PathSpec, text: str, *, whole_word: bool, ignore_case: bool
    ) -> list[PathSpec] | None:
        return cast(
            list[PathSpec] | None,
            await call(
                "files_containing",
                path,
                text=text,
                whole_word=whole_word,
                ignore_case=ignore_case,
            ),
        )

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
        if crossing:
            return name in _CROSSING_CALLS
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
        read_bytes=raw_bytes,
        read_range=raw_range,
        read_stream=read_stream,
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
        read_tree=read_tree,
        files_containing=files_containing,
        lines_containing=lines_containing,
        resolve_glob=make_resolve_glob(
            raw_readdir,
            limit,
            raw_stat,
            links.target_stat if links is not None else None,
            access,
            follow_of(ctx),
            noted,
        ),
        answers=answers,
    )
