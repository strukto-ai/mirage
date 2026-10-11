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

import functools
import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Collection
from dataclasses import dataclass, replace
from enum import StrEnum
from typing import Any, NoReturn, Protocol, overload

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.utils.paths import dot_refusal
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.commands.config import (
    AggregateFn,
    CommandFnResult,
    CommandIO,
    CommandOpts,
)
from mirage.context import (
    get_admission,
    get_current_session,
    get_mount_gate,
    get_walk_probe,
    hidden_refusal,
    session_visibility,
)
from mirage.context.session_context import require_paths_writable
from mirage.errors.constants import MISS_ERRORS
from mirage.errors.fs import (
    eacces,
    eisdir,
    enotsup,
    walk_refusal,
)
from mirage.errors.types import DotWalkError
from mirage.io import IOResult
from mirage.io.stream import close_quietly, ensure_stream, materialize
from mirage.policy.constants import METADATA_OPS
from mirage.policy.policies import Policies, get_op_policies, pre_vfs_gate
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, PathSpec, WalkProbe
from mirage.utils.filetype import get_extension
from mirage.utils.hidden import move_reveals, path_visible
from mirage.utils.path import norm, parent
from mirage.vfs.base import BaseVFS
from mirage.vfs.types import (
    DuOps,
    OperationFn,
    SearchOps,
)
from mirage.view.types import (
    StatOverlay,
)

logger = logging.getLogger(__name__)


class GenericCommandFn(Protocol):
    """GenericCommand body: a CommandFn with the backend's ops bound in front."""

    def __call__(
        self,
        ops: "CommandIO",
        accessor: Any,
        paths: list[PathSpec],
        texts: list[str],
        opts: CommandOpts,
    ) -> Awaitable[CommandFnResult]: ...


async def overlaid_stat(
    stat: OperationFn,
    overlay: StatOverlay,
    path: PathSpec,
    index: IndexCacheStore,
) -> FileStat:
    """Stat through the backend, then merge the namespace attr overlay.

    Bound via ``partial(overlaid_stat, stat_fn, overlay)`` so stat-
    rendering commands (ls) show chmod/chown/touch state the backend
    itself cannot hold. Guarded itself because the overlay branch binds
    the raw backend stat rather than a CommandIO slot.

    Args:
        stat (OperationFn): backend stat ``(path, index) -> FileStat``.
        overlay (StatOverlay): namespace merge ``(virtual, stat) -> stat``.
        path (PathSpec): entry being statted.
        index (IndexCacheStore): cache index threaded through.
    """
    if path.walk_error is not None:
        raise walk_refusal(path)
    _refuse_hidden(path, create=False)
    return overlay(path.virtual, await stat(path, index))


@overload
def bound_op(
    fn: OperationFn, accessor: Accessor, index: IndexCacheStore
) -> OperationFn: ...


@overload
def bound_op(fn: None, accessor: Accessor, index: IndexCacheStore) -> None: ...


def bound_op(
    fn: OperationFn | None, accessor: Accessor, index: IndexCacheStore
) -> OperationFn | None:
    """Bind the backend accessor and cache index into an op for the generics.

    A generic command calls its injected ops as ``op(path)``: backend
    identity (the accessor) and index-backed path resolution (gdrive,
    gmail, slack, ... resolve a path to its real id through the index)
    are wiring, so both bind here, mirroring the TS builders' closures.
    ``None`` passes through so a backend/test can still opt out of
    streaming.

    Args:
        fn (OperationFn | None): backend op ``(accessor, path, *, index)``,
            or None to opt out of streaming.
        accessor (Accessor): backend handle bound into the op.
        index (IndexCacheStore): the per-call cache index.
    """
    if fn is None:
        return None
    return functools.partial(fn, accessor, index=index)


class Operation(StrEnum):
    WRITE = "write"
    EXISTS = "exists"
    MKDIR = "mkdir"
    UNLINK = "unlink"
    RMDIR = "rmdir"
    RM_R = "rm_r"
    RENAME = "rename"
    COPY = "copy"
    TRUNCATE = "truncate"


@dataclass(frozen=True)
class GenericCommand:
    name: str
    fn: GenericCommandFn
    write: bool = False
    aggregate: AggregateFn | None = None
    read: bool = False


def require_op(ops: CommandIO, op: Operation) -> OperationFn:
    """Return a backend op, or one that refuses when the backend
    omits it.

    A backend without the write-side ops (github, notion, a
    database) still runs every generic command, because only the
    write itself knows whether a line writes: ``gzip -c``, ``tar
    -t`` and ``split -n 1/2`` never call the op, and a line that
    does is refused at that call with ENOTSUP for the path it
    named, which the command renders in its own GNU voice, as a
    filesystem that does not allow the operation would. Mirrors TS
    ``requireOp``.

    Args:
        ops (CommandIO): The mount's table.
        op (Operation): Required backend operation.
    """
    fn: OperationFn | None = getattr(ops, op.value)
    if fn is None:
        return _with_operation_guards(
            functools.partial(_refuse_missing, op), op.value
        )
    return fn


def mount_io(opts: CommandOpts) -> CommandIO:
    """The table of the mount a command runs on.

    Args:
        opts (CommandOpts): the command's options.

    Raises:
        TypeError: the command ran outside a mount.
    """
    if opts.io is None:
        raise TypeError(f"{opts.command}: ran without its mount's table")
    return opts.io


def over_mount_io(
    build: Callable[[CommandIO], Callable[..., Any]],
    wrap: Callable[[CommandIO], CommandIO] | None = None,
) -> Callable[..., Any]:
    """A handler that builds ``build``'s handler over the running mount's
    table, wrapped by ``wrap``, on every call.

    For a builder that reads its slots once, up front: the table is the
    mount's, so it is only known once a command runs.

    Args:
        build (Callable): makes the handler for one table.
        wrap (Callable | None): the guards to put over the table first.
    """

    async def run(
        accessor: Accessor,
        paths: list[PathSpec],
        texts: list[str],
        opts: CommandOpts,
    ) -> Any:
        io = mount_io(opts)
        handler = build(wrap(io) if wrap is not None else io)
        return await handler(accessor, paths, texts, opts)

    return run


def _without_accessor(method: Callable[..., Any]) -> OperationFn:
    """``method`` callable the way a command calls a slot.

    Commands still pass an accessor in front of every call; the VFS
    holds its own, so it is dropped here.

    Args:
        method (Callable[..., Any]): a bound VFS function.
    """

    def call(accessor: Accessor, *args: Any, **kwargs: Any) -> Any:
        return method(*args, **kwargs)

    return call


async def _exists_by_stat(
    vfs: BaseVFS, accessor: Accessor, path: PathSpec
) -> bool:
    """Whether ``stat`` finds anything at ``path``.

    Args:
        vfs (BaseVFS): the VFS to ask.
        accessor (Accessor): the command's accessor, unused.
        path (PathSpec): the path.
    """
    try:
        await vfs.stat(path)
    except (FileNotFoundError, NotADirectoryError):
        return False
    return True


def _reader(vfs: BaseVFS) -> Callable[..., Awaitable[bytes]]:
    """What a command reads: the stored bytes through ``vfs.read``.

    So an in-place edit (``sed -i``) writes back what it read and a byte
    read agrees with a stream. Only a VFS with no ``read`` of its own
    (gdocs, gsheets, gslides, whose stored form is the rendering) is read
    through the renderer of the path's filetype. Both are looked up per
    call, as the dispatcher looks them up; the dispatcher renders for the
    surfaces that show files.

    Args:
        vfs (BaseVFS): the mounted VFS.
    """

    async def read(
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        renderer = (
            None
            if vfs.supports("read")
            else vfs.renderers.get(get_extension(path.virtual) or "")
        )
        if renderer is None:
            return await vfs.read(path, index, offset, size)
        rendered: bytes = await getattr(vfs, renderer)(
            path, index, offset, size
        )
        return rendered

    return read


def command_io(vfs: BaseVFS) -> CommandIO:
    """The command tier's table for ``vfs``, built from its functions.

    A function the VFS does not define is an absent slot, except the two
    every reader needs: a stream, which reads the file whole when the VFS
    does not stream, and an existence check, which asks ``stat``. A
    ranged read is the VFS's own ``read`` only when it reads ranges.

    Args:
        vfs (BaseVFS): the mounted VFS.
    """

    def slot(name: str) -> OperationFn | None:
        if not vfs.supports(name):
            return None
        return _without_accessor(getattr(vfs, name))

    read_bytes = _without_accessor(_reader(vfs))
    streams = vfs.supports("read_stream")
    return CommandIO(
        readdir=_without_accessor(vfs.readdir),
        read_bytes=read_bytes,
        stat=_without_accessor(vfs.stat),
        read_stream=(
            _without_accessor(vfs.read_stream)
            if streams
            else functools.partial(stream_from_bytes, read_bytes)
        ),
        read_range=read_bytes if vfs.reads_ranges else None,
        exists=slot("exists") or functools.partial(_exists_by_stat, vfs),
        find=slot("find"),
        du=(
            DuOps(
                size=_without_accessor(vfs.du_size),
                entries=_without_accessor(vfs.du_entries),
            )
            if vfs.supports("du_size") and vfs.supports("du_entries")
            else None
        ),
        write=slot("write"),
        append=slot("append"),
        pwrite=slot("pwrite"),
        create=slot("create"),
        mkdir=slot("mkdir"),
        unlink=slot("unlink"),
        rmdir=slot("rmdir"),
        rm_r=slot("rm_r"),
        rename=slot("rename"),
        copy=slot("copy"),
        dir_copy=slot("dir_copy"),
        truncate=slot("truncate"),
        set_attrs=slot("setattr"),
        is_mounted=_without_accessor(vfs.is_mounted),
        local=vfs.local,
        max_glob_matches=vfs.max_glob_matches,
        max_du_entries=vfs.max_du_entries,
        search=(
            SearchOps(
                search=_without_accessor(vfs.search),
                search_many=slot("search_many"),
                meta=vfs.search_meta,
            )
            if vfs.supports("search")
            else None
        ),
        files_containing=slot("files_containing"),
        searchable=vfs.searchable,
        lines_containing=slot("lines_containing"),
        before_full_scan=slot("before_full_scan"),
    )


async def _dispatched_bytes(
    dispatch: DispatchFn,
    accessor: Accessor | None,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    """A command's whole or ranged read of the stored bytes, at the dispatcher.

    Args:
        dispatch (DispatchFn): the command's dispatcher.
        accessor (Accessor | None): unused; the dispatcher finds the mount.
        path (PathSpec): the file.
        index (IndexCacheStore): unused; the mount brings its own.
        offset (int): first byte of the window.
        size (int | None): window length, None for the rest.
    """
    data, _ = await dispatch(
        "read", path, filetype=None, offset=offset, size=size
    )
    return await materialize(data) or b""


async def _dispatched_stream(
    dispatch: DispatchFn,
    accessor: Accessor | None,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> AsyncIterator[bytes]:
    """A command's streamed read of the stored bytes, at the dispatcher.

    Opened at the first pull, as a backend stream is.

    Args:
        dispatch (DispatchFn): the command's dispatcher.
        accessor (Accessor | None): unused; the dispatcher finds the mount.
        path (PathSpec): the file.
        index (IndexCacheStore): unused; the mount brings its own.
    """
    data, _ = await dispatch("read", path, stream=True, filetype=None)
    source = ensure_stream(data)
    try:
        async for chunk in source:
            yield chunk
    finally:
        await close_quietly(source)


async def dispatched_call(
    dispatch: DispatchFn, name: str, path: PathSpec, /, **kwargs: Any
) -> Any:
    """Send one call to the dispatcher and hand back its answer.

    The one way a command's slot, a cross-mount run and a relayed command
    reach a mount: the dispatcher finds the mount and judges the call on
    its way there.

    Args:
        dispatch (DispatchFn): the command's dispatcher.
        name (str): the dispatcher function.
        path (PathSpec): the path it acts on.
        **kwargs: the function's own keywords.
    """
    result, _ = await dispatch(name, path, **kwargs)
    return result


# Each slot the dispatcher answers: the function it sends and what a
# command's positional arguments after the path are called there.
# ``index`` is the mount's own at the dispatcher, so it is dropped.
_DISPATCHED_SLOTS: dict[str, tuple[str, tuple[str, ...]]] = {
    "write": ("write", ("data", "index")),
    "append": ("append", ("data", "index")),
    "pwrite": ("pwrite", ("data", "offset", "index")),
    "create": ("create", ()),
    "mkdir": ("mkdir", ("parents",)),
    "unlink": ("unlink", ("index",)),
    "rmdir": ("rmdir", ("index",)),
    "rm_r": ("rm_r", ()),
    "rename": ("rename", ("dst",)),
    "copy": ("copy", ("dst",)),
    "dir_copy": ("dir_copy", ("dst",)),
    "truncate": ("truncate", ("length", "no_create")),
    "set_attrs": ("setattr", ()),
    "find": ("find", ("index",)),
}

# The slots that change the mount: with no dispatcher there is nowhere to
# judge and settle them.
_DISPATCHED_WRITES = frozenset(_DISPATCHED_SLOTS) - {"find"}


async def _slot_call(
    dispatch: DispatchFn,
    name: str,
    names: tuple[str, ...],
    accessor: Accessor | None,
    path: PathSpec,
    /,
    *args: Any,
    **kwargs: Any,
) -> Any:
    """A command's slot call, sent to the dispatcher.

    Args:
        dispatch (DispatchFn): the command's dispatcher.
        name (str): the dispatcher function.
        names (tuple[str, ...]): what the positionals after the path are
            called there.
        accessor (Accessor | None): unused; the dispatcher finds the mount.
        path (PathSpec): the path the call acts on.
        *args: the call's positionals after the path.
        **kwargs: its keywords.
    """
    if len(args) > len(names):
        raise TypeError(f"{name}: takes {len(names)} arguments after the path")
    named = {**dict(zip(names, args)), **kwargs}
    named.pop("index", None)
    return await dispatched_call(dispatch, name, path, **named)


def dispatched_slots(
    dispatch: DispatchFn, slots: Collection[str]
) -> dict[str, Any]:
    """``slots``, each sent to the dispatcher.

    Args:
        dispatch (DispatchFn): the command's dispatcher.
        slots (Collection[str]): slot names from the dispatched table.
    """
    return {
        slot: functools.partial(_slot_call, dispatch, *_DISPATCHED_SLOTS[slot])
        for slot in slots
    }


def dispatched_io(ops: CommandIO, dispatch: DispatchFn | None) -> CommandIO:
    """Return ``ops`` whose reads, writes and one-call walks go through the
    dispatcher.

    The dispatcher checks hides, the command's path rule, the mount's mode and
    policy, serves a warm copy and fills a cold one, settles a write's
    caches and receipt under its name's hold, and declines a one-call walk
    (find, du, search, a tree copy or removal) whose subtree the caller's
    view restricts, so a command's call answers what the same call
    through ``ws.vfs`` or FUSE answers. A slot the backend does not have
    stays absent. With no dispatcher (a host running a command straight
    on its mount) the reads stay the backend's and each write is refused
    as one the backend does not have: the dispatcher is where a write is
    judged and settled.

    Args:
        ops (CommandIO): the mount's table.
        dispatch (DispatchFn | None): the command's dispatcher.
    """
    if dispatch is None:
        refused: dict[str, Any] = {
            slot: _with_operation_guards(
                functools.partial(_refuse_missing, slot), slot
            )
            for slot in _DISPATCHED_WRITES
            if getattr(ops, slot) is not None
        }
        return replace(ops, **refused)
    reader = functools.partial(_dispatched_bytes, dispatch)
    return replace(
        ops,
        read_bytes=reader,
        read_stream=functools.partial(_dispatched_stream, dispatch),
        read_range=reader if ops.read_range is not None else None,
        du=(
            DuOps(
                size=functools.partial(
                    _slot_call, dispatch, "du_size", ("index",)
                ),
                entries=functools.partial(
                    _slot_call, dispatch, "du_entries", ("index",)
                ),
            )
            if ops.du is not None
            else None
        ),
        search=(
            replace(
                ops.search,
                search=functools.partial(
                    _slot_call, dispatch, "search", ("query", "index")
                ),
            )
            if ops.search is not None
            else None
        ),
        **dispatched_slots(
            dispatch,
            [s for s in _DISPATCHED_SLOTS if getattr(ops, s) is not None],
        ),
    )


async def _refuse_missing(op: str, *args: Any, **kwargs: Any) -> NoReturn:
    """Refuse a call to an op the backend does not have.

    The path it names is the one the op would have written: a copy's
    destination, otherwise its first path.

    Args:
        op (str): the missing operation's slot.
        *args: the call's positionals, the accessor and PathSpecs among
            them.
        **kwargs: ignored.
    """
    specs = [arg for arg in args if isinstance(arg, PathSpec)]
    access = _MUTATIONS.get(op)
    raise enotsup(
        "backend",
        str(op),
        specs[1] if access and access.first_source else specs[0],
    )


async def _is_implicit_dir(
    ops: CommandIO, accessor: Accessor, path: PathSpec, index: IndexCacheStore
) -> bool:
    """Whether a path that failed stat with ENOENT is an implicit directory.

    Keyed backends (RAM/Redis/S3) have no directory entries: stat of a
    prefix that only exists through deeper keys raises ENOENT. The operand's
    own readdir cannot serve as the probe: synthetic hierarchies fabricate
    children for any name (postgres answers ``tables/views`` for a missing
    schema) and database backends raise driver errors for missing tables.
    The parent listing is authoritative instead: the operand is an implicit
    directory only if its parent's readdir lists it. When the operand is
    the mount root there is no parent to list, so its own readdir decides
    (root listings are real in every backend). Any probe failure is a
    negative probe (the original ENOENT stands), never an error to surface,
    which is why the except is deliberately broad.

    Args:
        ops (CommandIO): Backend I/O bundle providing ``readdir``.
        accessor (Accessor): Backend accessor.
        path (PathSpec): The operand whose stat raised ENOENT.
        index (IndexCacheStore): Index cache store for ``readdir``.
    """
    target = norm(path.virtual)
    key = path.vfs_path.strip("/")
    if not key:
        try:
            entries = await ops.readdir(accessor, path, index)
        except MISS_ERRORS:
            return False
        return bool(entries)
    parent_key = key.rsplit("/", 1)[0] if "/" in key else ""
    parent_virtual = parent(target)
    parent_path = PathSpec(
        virtual=parent_virtual, directory=parent_virtual, vfs_path=parent_key
    )
    try:
        entries = await ops.readdir(accessor, parent_path, index)
    except MISS_ERRORS:
        return False
    return any(norm(entry) == target for entry in entries)


def _is_namespace_dir(opts: CommandOpts, path: PathSpec) -> bool:
    """Whether a path no backend knows is a directory the namespace owns.

    The third way a read operand can be a directory, after the explicit
    stat row and the implicit keyed-backend prefix. A directory that
    exists only because a mount or a link sits under it (``/repos`` when
    ``/repos/alpha`` is mounted) belongs to no backend at all: the keys
    live in another VFS, so the mount this command is bound to can
    neither stat it nor list it, and every read command reported it
    missing while stat, file, ls, du, find and tree all called it a
    directory.

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
        opts (CommandOpts): the invocation's bag, for ``ns.child_mounts``.
        path (PathSpec): the operand whose stat raised ENOENT.
    """
    if opts.ns is None or opts.ns.child_mounts is None:
        return False
    return bool(opts.ns.child_mounts(path.virtual))


_READ_SLOTS = ("read_bytes", "read_stream", "read_range")


async def _read_hit_a_dir(
    ops: CommandIO,
    accessor: Accessor,
    index: IndexCacheStore,
    path: PathSpec,
    exc: BaseException | None,
) -> bool:
    """Whether a failed or empty read was a read of a directory.

    Asked after a failure or EOF without bytes: some drivers report an
    empty stream for directories. Nonempty reads need no extra probe.
    One that knows says so (gdrive,
    box, dropbox and disk raise IsADirectoryError), a keyed store answers
    ENOENT because a directory there is a set of keys rather than an
    object, and sftp answers with an opaque non-OSError.

    Four ways the answer can be yes, in probe-cost order. The errno
    itself costs nothing. The stat is one call, and a stat that ANSWERS
    ends the cascade either way: a file is a file, and the later probes
    only make sense for a path stat could not see. Reaching past a
    successful stat read a rule-refused file as a directory, because its
    parent's listing names it. The parent listing is one call and is the
    only thing that can tell a missing key from a prefix that exists only
    through deeper keys. The namespace's child names cost nothing and are
    the only authority for a directory that exists because a mount or a
    link sits under it, which no backend can see because those keys live
    in another VFS.

    A no leaves the original error untouched, so nothing is swallowed:
    the caller re-raises what the backend said. Both probes are broad for
    that same reason, which is the one ``_is_implicit_dir`` states for
    its own catches: a probe that fails is a negative probe, never an
    error to surface. Surfacing one would replace the read's error with
    one from a call the user never made, and it is the read that failed.
    ``_is_implicit_dir`` narrows to MISS_ERRORS because for its other
    caller the stat IS the operation; here it is a probe, so the wider
    catch belongs on this side of the call.

    Args:
        ops (CommandIO): the backend's IO bundle, for stat and readdir.
        accessor (Accessor): backend handle.
        index (IndexCacheStore): the call's cache index.
        path (PathSpec): the operand whose read failed.
        exc (BaseException | None): the failure, or None for an empty read.
    """
    if isinstance(exc, IsADirectoryError):
        return True
    if isinstance(exc, DotWalkError):
        # The path did not resolve at all, which no reading turns into a
        # directory; its parent may well list the name it simplifies to.
        return False
    try:
        st: FileStat | None = await ops.stat(accessor, path, index)
    except Exception as probe:
        # A probe that fails is a negative probe, never an error to
        # surface: `exc` is what the user gets, and it is still live.
        logger.debug("read probe: stat %s failed: %s", path.virtual, probe)
        st = None
    if st is not None:
        return getattr(st, "type", None) == FileType.DIRECTORY
    try:
        if await _is_implicit_dir(ops, accessor, path, index):
            return True
    except Exception as probe:
        # Negative probe, as above. `_is_implicit_dir` narrows to
        # MISS_ERRORS for its other caller, where the stat is the
        # operation rather than a probe.
        logger.debug("read probe: listing %s failed: %s", path.virtual, probe)
    # The same fact `_is_namespace_dir` reads, reached from the adapter
    # rather than from the bag: this guard wraps a slot and never sees a
    # CommandOpts, and the factory stamps the very callable
    # `opts.ns.child_mounts` would hand over.
    return bool(
        ops.glob_children is not None and ops.glob_children(path.virtual)
    )


async def _drain_refusing_dirs(
    ops: CommandIO,
    accessor: Accessor,
    index: IndexCacheStore,
    path: PathSpec,
    source: AsyncIterator[bytes],
) -> AsyncIterator[bytes]:
    empty = True
    try:
        async for chunk in source:
            empty = empty and not chunk
            yield chunk
    except Exception as exc:
        if await _read_hit_a_dir(ops, accessor, index, path, exc):
            raise eisdir(path) from None
        raise
    finally:
        await close_quietly(source)
    if empty and await _read_hit_a_dir(ops, accessor, index, path, None):
        raise eisdir(path)


def _guarded_read_stream(
    ops: CommandIO,
    fn: OperationFn,
    accessor: Accessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    **kwargs: Any,
) -> AsyncIterator[bytes]:
    return _drain_refusing_dirs(
        ops, accessor, index, path, fn(accessor, path, index, **kwargs)
    )


async def _guarded_read(
    ops: CommandIO,
    fn: OperationFn,
    accessor: Accessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    **kwargs: Any,
) -> bytes:
    try:
        data: bytes = await fn(accessor, path, index, **kwargs)
    except Exception as exc:
        if await _read_hit_a_dir(ops, accessor, index, path, exc):
            raise eisdir(path) from None
        raise
    if not data and await _read_hit_a_dir(ops, accessor, index, path, None):
        raise eisdir(path)
    return data


def with_dir_guard(ops: CommandIO) -> CommandIO:
    """Return ``ops`` whose reads refuse a directory with GNU's EISDIR.

    The read family's counterpart of ``with_command_guards`` and
    ``with_slash_guard``: reading a directory is never a legitimate call,
    so the refusal belongs to the slot rather than to each builder's
    wiring. It used to belong to the wiring, and 23 of the read builders
    passed a bare ``bound_op(ops.read_stream, ...)`` instead, so a
    directory on a keyed backend reported ENOENT.

    Refined after failure or an empty read: some drivers return EOF for
    directories. Nonempty successful reads need no extra probe.
    The refusal is built from the operand's
    own PathSpec, so it carries the virtual path: a raw disk error names
    the host path, which is the mount's own business and must not reach a
    user-facing line.

    The catch is broad and the re-raise is unconditional, which is the
    only way to cover a backend whose directory read is not an OSError at
    all (asyncssh raises SFTPFailure). Nothing is swallowed: the original
    error is re-raised untouched unless a probe positively confirms a
    directory.

    Args:
        ops (CommandIO): the backend's IO adapter.
    """
    changes: dict[str, Any] = {}
    for slot in _READ_SLOTS:
        fn = getattr(ops, slot)
        if fn is None:
            continue
        wrapper = (
            _guarded_read_stream if slot == "read_stream" else _guarded_read
        )
        changes[slot] = functools.partial(wrapper, ops, fn)
    return replace(ops, **changes)


async def _stat_refusing_dirs(
    ops: CommandIO, accessor: Accessor, opts: CommandOpts, path: PathSpec
) -> FileStat:
    try:
        st: FileStat = await ops.stat(accessor, path, opts.index)
    except DotWalkError:
        raise
    except FileNotFoundError:
        if await _is_implicit_dir(ops, accessor, path, opts.index):
            raise eisdir(path) from None
        if _is_namespace_dir(opts, path):
            raise eisdir(path) from None
        raise
    if getattr(st, "type", None) == FileType.DIRECTORY:
        raise eisdir(path)
    return st


def dir_aware_stat(
    ops: CommandIO, accessor: Accessor, opts: CommandOpts
) -> OperationFn:
    """Bound stat for the read-family chokepoint (``split_readable``).

    A directory operand fails with EISDIR instead of succeeding
    (explicit, via the stat type) or failing with ENOENT (implicit
    keyed-backend directory via a readdir probe, or a namespace-only
    mount parent via the name plane), so cat/head/tail report GNU's
    ``Is a directory`` and keep the remaining operands (#457). Called as
    ``stat(path)``; mirrors ``dirAwareStat`` in adapter.ts.

    Takes the whole ``opts`` rather than its index because this is where
    every read command decides what a directory is, and the facts that
    answer that question arrive on the bag: threading them one at a time
    would mean editing every one of the two dozen builders again for the
    next one.

    Args:
        ops (CommandIO): Backend I/O bundle providing ``stat``/``readdir``.
        accessor (Accessor): Backend accessor bound into stats.
        opts (CommandOpts): the invocation's bag, for the index and the
            namespace's child names.
    """
    return functools.partial(_stat_refusing_dirs, ops, accessor, opts)


async def _stream_refusing_dirs(
    ops: CommandIO, accessor: Accessor, opts: CommandOpts, path: PathSpec
) -> AsyncIterator[bytes]:
    await _stat_refusing_dirs(ops, accessor, opts, path)
    async for chunk in ops.read_stream(accessor, path, opts.index):
        yield chunk


def dir_aware_stream(
    ops: CommandIO, accessor: Accessor, opts: CommandOpts
) -> OperationFn:
    """Bound read stream for the per-operand chokepoint (``read_operands``).

    The operand is stat'ed first so a directory fails with EISDIR before
    any backend read runs (sftp reads of a directory raise an opaque
    ``Failure``, not ENOENT), and an ENOENT for an implicit keyed-backend
    directory or a namespace-only mount parent is refined the same way
    ``dir_aware_stat`` does, before the generic formats the stderr line
    (#457). Called as ``read(path)``; mirrors ``dirAwareStream`` in
    adapter.ts.

    Args:
        ops (CommandIO): Backend I/O bundle providing ``stat``/``readdir``
            and ``read_stream``.
        accessor (Accessor): Backend accessor bound into reads.
        opts (CommandOpts): the invocation's bag, for the index and the
            namespace's child names.
    """
    return functools.partial(_stream_refusing_dirs, ops, accessor, opts)


async def resolve_or_empty(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    index: IndexCacheStore,
) -> list[PathSpec]:
    """Expand glob operands, or [] when there is nothing to resolve.

    The read-family wiring entry: an unmounted backend or an empty
    operand list resolves to no paths, which the generics read as stdin
    mode. Operand semantics (report-and-continue, directory refusal)
    live in the generics via ``split_readable``; this is wiring only.

    Args:
        ops (CommandIO): Backend I/O bundle providing ``resolve_glob``.
        accessor (Accessor): Backend accessor.
        paths (list[PathSpec]): Raw path operands (may hold globs).
        index (IndexCacheStore): Index cache store.
    """
    if paths and ops.is_mounted(accessor):
        return await ops.resolve_glob(accessor, paths, index)
    return []


def _refuse_hidden(path: PathSpec, create: bool) -> None:
    """Refuse a hidden path the way nonexistence would.

    ENOENT for anything acting on the path; a create answers as
    :func:`hidden_refusal` says, EACCES only when the directory it
    lands in is visible. Raised at the command guard so each command
    renders the refusal through its own missing-file wording,
    indistinguishable from a real miss.

    Args:
        path (PathSpec): the operand being guarded.
        create (bool): whether the op creates the path it names.
    """
    vis = session_visibility()
    if path_visible(vis, path.virtual):
        return
    raise hidden_refusal(vis, path.virtual, create)


async def _guarded_readdir(
    fn: OperationFn, *args: Any, **kwargs: Any
) -> list[str]:
    """Readdir with hidden names dropped from the listing.

    Args:
        fn (OperationFn): the raw backend readdir.
        *args: the call's positionals; the first PathSpec is the
            directory being listed.
        **kwargs: forwarded untouched.
    """
    parent = next(a for a in args if isinstance(a, PathSpec))
    _refuse_hidden(parent, create=False)
    entries = await fn(*args, **kwargs)
    base = parent.virtual.rstrip("/")
    vis = session_visibility()
    return [
        e
        for e in entries
        if path_visible(vis, f"{base}/{e.rstrip('/').rsplit('/', 1)[-1]}")
    ]


def _move_would_reveal(src: PathSpec, dst: PathSpec) -> bool:
    """Whether the session's hides make this relocation a reveal.

    Args:
        src (PathSpec): the subtree being moved or copied.
        dst (PathSpec): where it would land.
    """
    return move_reveals(session_visibility(), src.virtual, dst.virtual)


def refuse_reveal(src: PathSpec, dst: PathSpec) -> None:
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
    """
    if _move_would_reveal(src, dst):
        raise eacces(src.virtual)


async def _guarded_exists(fn: OperationFn, *args: Any, **kwargs: Any) -> bool:
    """Exists that answers False for a hidden path, never a refusal.

    Args:
        fn (OperationFn): the raw backend exists.
        *args: the call's positionals; the first PathSpec is probed.
        **kwargs: forwarded untouched.
    """
    probed = next(a for a in args if isinstance(a, PathSpec))
    if not path_visible(session_visibility(), probed.virtual):
        return False
    return bool(await fn(*args, **kwargs))


@dataclass(frozen=True)
class Mutation:
    create: bool = False
    first_source: bool = False
    subtree: bool = False


_MUTATIONS = {
    "write": Mutation(create=True),
    "mkdir": Mutation(create=True),
    "append": Mutation(create=True),
    "pwrite": Mutation(create=True),
    "create": Mutation(create=True),
    "truncate": Mutation(create=True),
    "unlink": Mutation(),
    "rmdir": Mutation(),
    "set_attrs": Mutation(),
    "rm_r": Mutation(subtree=True),
    "rename": Mutation(subtree=True),
    "copy": Mutation(first_source=True),
    "dir_copy": Mutation(first_source=True, subtree=True),
}


def _check_command_paths(
    paths: list[PathSpec],
    slot: str,
    check_hidden: bool = True,
    check_mode: bool = True,
) -> None:
    """Enforce the admitted command's paths and mount capabilities.

    Args:
        paths (list[PathSpec]): backend call endpoints.
        slot (str): command adapter capability being used.
        check_hidden (bool): false only for private remnant deletion.
    """
    access = _MUTATIONS.get(slot)
    admission = get_admission()
    for position, path in enumerate(paths):
        if check_hidden:
            _refuse_hidden(
                path, create=position > 0 or bool(access and access.create)
            )
        if admission is not None and slot not in ("stat", "exists"):
            admission.check(path.virtual)
    mount = get_mount_gate()
    if access is not None and check_mode and mount is not None:
        require_paths_writable(
            paths[1:] if access.first_source else paths,
            *mount,
            subtree=access.subtree,
        )


def _command_call(
    fn: OperationFn,
    slot: str,
    *args: Any,
    check_mode: bool = True,
    **kwargs: Any,
) -> Any:
    paths = [
        path
        for arg in args
        for path in (arg if isinstance(arg, (list, tuple)) else (arg,))
        if isinstance(path, PathSpec)
    ]
    _check_command_paths(paths, slot, check_mode=check_mode)
    return fn(*args, **kwargs)


def _with_operation_guards(fn: OperationFn, slot: str) -> OperationFn:
    access = _MUTATIONS.get(slot)
    policed = functools.partial(
        _policy_call,
        _op_policy_scope(),
        fn,
        slot,
        access is not None,
        access.first_source if access else False,
    )
    guarded = functools.partial(_command_call, policed, slot)
    return functools.partial(
        _walked_call, get_walk_probe(), slot == "mkdir", guarded
    )


# The slots that take a path and still reach the backend past the
# dispatcher, or whose failed walk a reader words itself: the kernel
# resolves a path before the op sees it, whatever the op then does, so
# presence facts (stat, exists) are walked too.
_WALK_SLOTS = ("read_bytes", "read_range", "stat", "exists", "readdir")


async def _walk_admit(
    probe: WalkProbe, specs: list[PathSpec], creates: bool
) -> None:
    """Raise what the first unwalkable operand's dots answer.

    Args:
        probe (WalkProbe): the workspace stat and link follow the walk
            reads.
        specs (list[PathSpec]): the call's PathSpec positionals that
            carry a dotted spelling.
        creates (bool): the op creates the name it is handed (mkdir).
    """
    for spec in specs:
        refusal = await dot_refusal(probe.stat, spec, probe.follow, creates)
        if refusal is not None:
            raise refusal


async def _walked_await(
    admit: Callable[[], Awaitable[None]], pending: Awaitable[Any]
) -> Any:
    """Await an op once its operands walk; close it unstarted if not.

    Args:
        admit (Callable[[], Awaitable[None]]): the bound operand walk.
        pending (Awaitable[Any]): the op's not-yet-awaited result.
    """
    try:
        await admit()
    except BaseException:
        close = getattr(pending, "close", None)
        if close is not None:
            close()
        raise
    return await pending


async def _walked_stream(
    admit: Callable[[], Awaitable[None]], source: AsyncIterator[bytes]
) -> AsyncIterator[bytes]:
    """Drain a stream once its operands walk; close it if they do not.

    Args:
        admit (Callable[[], Awaitable[None]]): the bound operand walk.
        source (AsyncIterator[bytes]): the not-yet-started stream.
    """
    try:
        await admit()
        async for chunk in source:
            yield chunk
    finally:
        await close_quietly(source)


def _walked_call(
    walk: WalkProbe | None,
    creates: bool,
    fn: OperationFn,
    *args: Any,
    **kwargs: Any,
) -> Any:
    """Call a backend op once the dots of its PathSpec positionals walk.

    A plain def, as ``_guarded_call`` is one: the op's own return shape
    passes through, an awaitable awaited after the walk and a stream
    drained after it, so a refused walk never starts the op. An operand
    with no dotted spelling, the common case, costs one attribute read.
    One the walk already refused (``walk_error``) raises at call time,
    before anything else reads it.

    Args:
        walk (WalkProbe | None): the wrap-time probe, else the one bound
            to the running command is read at call time.
        creates (bool): the op creates the name it is handed (mkdir).
        fn (OperationFn): the guarded backend op.
        *args: the call's positionals, PathSpecs among them.
        **kwargs: forwarded untouched.
    """
    for arg in args:
        if isinstance(arg, PathSpec) and arg.walk_error is not None:
            raise walk_refusal(arg)
    specs = [
        arg
        for arg in args
        if isinstance(arg, PathSpec) and arg.dotted is not None
    ]
    probe = walk if walk is not None else get_walk_probe()
    if not specs or probe is None:
        return fn(*args, **kwargs)
    admit = functools.partial(_walk_admit, probe, specs, creates)
    result = fn(*args, **kwargs)
    if hasattr(result, "__aiter__") and not hasattr(result, "__await__"):
        return _walked_stream(admit, result)
    return _walked_await(admit, result)


def with_command_guards(ops: CommandIO) -> CommandIO:
    """Bind the command's path checks around the slots the dispatcher
    does not run.

    Reads, writes and one-call walks go through the dispatcher
    (``dispatched_io``), which judges each itself. ``stat``, ``exists``
    and ``readdir`` still reach the backend past it, so here a hidden
    path answers as a missing one, a listing drops the names the session
    hides, and a listed directory meets the command's path rule and the
    coded pre_vfs hooks. Every slot's operand dots are walked, a read's
    as it starts, so a reader that words a failed open itself gets the
    walk's refusal.

    Args:
        ops (CommandIO): the mount's table.
    """
    walk = get_walk_probe()
    scope = _op_policy_scope()
    read_stream = ops.read_stream

    def guarded_stream(
        accessor: Accessor, path: PathSpec, *args: Any, **kwargs: Any
    ) -> AsyncIterator[bytes]:
        # The walk at the first pull, as TypeScript's walkedStream does:
        # a reader that turns a failed open into its own words (awk's
        # `cannot open`) relays the stream through its own handler, so a
        # walk that already failed (a link loop) must surface where it
        # drains. Hides and the path rule are the dispatcher's.

        async def admit() -> None:
            if path.walk_error is not None:
                raise walk_refusal(path)
            probe = walk if walk is not None else get_walk_probe()
            if path.dotted is not None and probe is not None:
                await _walk_admit(probe, [path], False)

        return _walked_stream(
            admit, read_stream(accessor, path, *args, **kwargs)
        )

    changes: dict[str, Any] = {"read_stream": guarded_stream}
    for slot in _WALK_SLOTS:
        fn = getattr(ops, slot)
        if fn is None:
            continue
        guarded = fn
        if slot == "readdir":
            guarded = functools.partial(
                _guarded_readdir,
                functools.partial(_policy_readdir, scope, fn),
            )
        if slot not in _READ_SLOTS:
            guarded = functools.partial(_command_call, guarded, slot)
        if slot == "exists":
            guarded = functools.partial(_guarded_exists, guarded)
        changes[slot] = functools.partial(_walked_call, walk, False, guarded)
    return replace(ops, **changes)


def with_dispatch_rule_guard(dispatch: DispatchFn) -> DispatchFn:
    """Return ``dispatch`` marking each op with the admitted command's
    gate as ``rule_gate``, which the dispatcher judges on the paths the op
    reaches: the command's dispatcher skips its guarded slots, and the
    dispatcher cannot tell which command issued an op. A metadata op passes
    unmarked, as ``with_command_guards`` lets ``stat`` pass.

    Args:
        dispatch (DispatchFn): the workspace op dispatcher.
    """

    async def guarded(
        name: str, path: PathSpec, /, **options: Any
    ) -> tuple[Any, IOResult]:
        gate = get_admission()
        if gate is not None and name not in METADATA_OPS:
            options = {**options, "rule_gate": gate}
        return await dispatch(name, path, **options)

    return guarded


# (policies, mount prefix, session id); the unbound spelling for a
# registration-time wrap, which reads the live context per call.
_PolicyScope = tuple[Policies | None, str, str]
_UNBOUND_SCOPE: _PolicyScope = (None, "", "")


def _op_policy_scope() -> _PolicyScope:
    """The policies to consult for this op call, the mount prefix, and
    the session the command runs under.

    None is the fast path: no dispatched command bound policies, or
    none of them override pre_vfs, at the cost of two contextvar reads
    and one O(1) probe per slot call.
    """
    policies = get_op_policies()
    if policies is None or not policies.wants("pre_vfs"):
        return _UNBOUND_SCOPE
    gate = get_mount_gate()
    sess = get_current_session()
    return (
        policies,
        gate[0] if gate is not None else "",
        sess.session_id if sess is not None else "",
    )


def _live_policy_scope(scope: _PolicyScope) -> _PolicyScope:
    """The wrap-time scope when it caught a bound command, else the
    call-time context.

    The factory applies the guard inside the command's window, so its
    wrap-time capture also covers a reader the output pipeline drains
    after dispatch has reset the context (head/tail/wc bind lazy
    readers), with the prefix and session identity the drained op
    belongs to; a registration-time wrap (the object-store overrides,
    the loose-write chain) has no window when applied and reads the
    live context instead, which its eager handlers are inside.

    Args:
        scope (_PolicyScope): the wrap-time capture.
    """
    if scope[0] is not None:
        return scope
    return _op_policy_scope()


async def _policy_admit(
    policies: Policies,
    prefix: str,
    session_id: str,
    op: str,
    write: bool,
    first_source: bool,
    args: tuple[Any, ...],
) -> None:
    """Fire pre_vfs for each PathSpec positional of one slot call.

    The hides are not judged here: the command guards wrapped around
    this one answer them first, and the remnant cascade reaches below
    them on purpose to remove what the session cannot see.

    Args:
        policies (Policies): the bound admission policies.
        prefix (str): the executing mount's prefix, "" outside one.
        session_id (str): the session the command runs under.
        op (str): the slot name, which is the op name policies see.
        write (bool): whether the op mutates its paths.
        first_source (bool): whether the leading PathSpec is a
            read-only source (the copy slots).
        args: the call's positionals, PathSpecs among them.
    """
    first = True
    for arg in args:
        if isinstance(arg, PathSpec):
            mutates = write and not (first and first_source)
            await pre_vfs_gate(
                policies,
                op,
                arg,
                mutates,
                prefix,
                session_id,
                check_hidden=False,
            )
            first = False


async def _policy_call(
    scope: _PolicyScope,
    fn: OperationFn,
    op: str,
    write: bool,
    first_source: bool,
    *args: Any,
    **kwargs: Any,
) -> Any:
    """Call a backend op after admitting its paths through pre_vfs.

    Async, unlike the sync guards it wraps: the hooks are user
    coroutines. Every slot this wraps returns an awaitable, so the
    shape is preserved; readdir has its own wrapper.

    Args:
        scope (_PolicyScope): the wrap-time capture.
        fn (OperationFn): the guarded backend op.
        op (str): the slot name.
        write (bool): whether the op mutates its paths.
        first_source (bool): whether the leading PathSpec is a
            read-only source.
        *args: the call's positionals, PathSpecs among them.
        **kwargs: forwarded untouched.
    """
    policies, prefix, session_id = _live_policy_scope(scope)
    if policies is not None:
        await _policy_admit(
            policies, prefix, session_id, op, write, first_source, args
        )
    return await fn(*args, **kwargs)


async def _policy_readdir(
    scope: _PolicyScope, fn: OperationFn, *args: Any, **kwargs: Any
) -> list[str]:
    """Readdir admitted through pre_vfs for the directory it lists.

    Args:
        scope (_PolicyScope): the wrap-time capture.
        fn (OperationFn): the guarded backend readdir.
        *args: the call's positionals; the first PathSpec is the
            directory being listed.
        **kwargs: forwarded untouched.
    """
    policies, prefix, session_id = _live_policy_scope(scope)
    if policies is not None:
        parent_spec = next(a for a in args if isinstance(a, PathSpec))
        await pre_vfs_gate(
            policies,
            "readdir",
            parent_spec,
            False,
            prefix,
            session_id,
            check_hidden=False,
        )
    entries: list[str] = await fn(*args, **kwargs)
    return entries
