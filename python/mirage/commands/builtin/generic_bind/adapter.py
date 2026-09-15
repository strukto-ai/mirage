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

import errno
import functools
import os
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass, replace
from enum import StrEnum
from typing import Any, Protocol, overload

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.du import (DEFAULT_MAX_DU_ENTRIES,
                                                DuEntries)
from mirage.commands.config import CommandFnResult, CommandOpts, ProvisionFn
from mirage.context import (effective_path_mode, get_admission,
                            get_current_session, get_mount_gate,
                            get_op_policies, hidden_paths_intersect,
                            path_allowed, readonly_below)
from mirage.ops.types import ChildMounts, LinkTargetStat, StatOverlay
from mirage.policy.policies import Policies, pre_ops_gate
from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.utils.errors import MISS_ERRORS, ReadOnlyError, eisdir
from mirage.utils.glob_walk import DEFAULT_MAX_GLOB_MATCHES, make_resolve_glob
from mirage.utils.hidden import move_reveals
from mirage.utils.path import norm, parent
from mirage.utils.remnants import remove_remnants, visible_below

OperationFn = Callable[..., Any]

# Per-slot op shapes, the twins of adapter.ts's ReaddirOp/StatOp/...
# generics. The accessor parameter stays Any on purpose: every backend
# annotates its own concrete accessor, and a `accessor: Accessor`
# protocol parameter would reject all of them under contravariance
# (TS solves this with `<A extends Accessor>`; a generic frozen
# dataclass plus functools.partial makes that plumbing cost more here
# than the accessor check is worth — the slot SHAPE is the guard that
# stops readdir being wired where stat belongs). The leading two
# parameters are positional-only because backends name the path
# parameter both `path` and `path_spec`.


class ReaddirOp(Protocol):

    def __call__(self,
                 accessor: Any,
                 path: PathSpec,
                 /,
                 index: IndexCacheStore = ...) -> Awaitable[list[str]]:
        ...


class ReadBytesOp(Protocol):

    def __call__(self,
                 accessor: Any,
                 path: PathSpec,
                 /,
                 index: IndexCacheStore = ...) -> Awaitable[bytes]:
        ...


class ReadStreamOp(Protocol):
    """Backend streams are async iterators; the polymorphic reader
    contract (bytes / awaitable) exists only at the generics' bound-
    reader boundary (``normalized_read``), never on the slot itself:
    the cache wrapper and the dir-refusing chokepoint both ``async
    for`` over this directly."""

    def __call__(self,
                 accessor: Any,
                 path: PathSpec,
                 /,
                 index: IndexCacheStore = ...) -> AsyncIterator[bytes]:
        ...


class StatOp(Protocol):

    def __call__(self,
                 accessor: Any,
                 path: PathSpec,
                 /,
                 index: IndexCacheStore = ...) -> Awaitable[FileStat]:
        ...


class ReadRangeOp(Protocol):
    """A byte window without reading the whole object.

    Called as ``(accessor, path, index, offset, size)``; most backends
    point it at their own ``read_bytes``, which already takes the
    window.
    """

    def __call__(self,
                 accessor: Any,
                 path: PathSpec,
                 /,
                 index: IndexCacheStore = ...,
                 offset: int = ...,
                 size: int | None = ...) -> Awaitable[bytes]:
        ...


class WriteOp(Protocol):

    def __call__(self, accessor: Any, path: PathSpec, data: bytes,
                 /) -> Awaitable[None]:
        ...


class ExistsOp(Protocol):

    def __call__(self, accessor: Any, path: PathSpec, /) -> Awaitable[bool]:
        ...


class PathOp(Protocol):

    def __call__(self, accessor: Any, path: PathSpec, /) -> Awaitable[None]:
        ...


class RmdirOp(Protocol):
    """Remove an empty directory. ``index`` joins the read-family slots'
    contract because the hidden-remnant guard turns a refused rmdir into
    a raw listing of the same directory, and an indexed backend cannot
    list a nested path through ``NULL_INDEX``; the backend itself does
    not consult it."""

    def __call__(self,
                 accessor: Any,
                 path: PathSpec,
                 /,
                 index: IndexCacheStore = ...) -> Awaitable[None]:
        ...


class RmTreeOp(Protocol):
    """Remove a subtree. The builders ignore any returned value
    (databricks reports the removed keys for its own rename path), so
    the return stays loose where unlink/rmdir pin None."""

    def __call__(self, accessor: Any, path: PathSpec, /) -> Awaitable[Any]:
        ...


class MkdirOp(Protocol):

    def __call__(self,
                 accessor: Any,
                 path: PathSpec,
                 /,
                 parents: bool = ...) -> Awaitable[None]:
        ...


class PairOp(Protocol):
    """Rename/copy/dir-copy: two paths on the same backend."""

    def __call__(self, accessor: Any, src: PathSpec, dst: PathSpec,
                 /) -> Awaitable[None]:
        ...


class TruncateOp(Protocol):

    def __call__(self, accessor: Any, path: PathSpec, length: int,
                 /) -> Awaitable[None]:
        ...


class IsMountedOp(Protocol):

    def __call__(self, accessor: Any, /) -> bool:
        ...


class DuSizeOp(Protocol):

    def __call__(self,
                 accessor: Any,
                 path: PathSpec,
                 /,
                 index: IndexCacheStore = ...) -> Awaitable[int]:
        ...


class DuEntriesOp(Protocol):

    def __call__(self,
                 accessor: Any,
                 path: PathSpec,
                 /,
                 index: IndexCacheStore = ...) -> Awaitable[DuEntries]:
        ...


class ResolveGlobOp(Protocol):
    """Glob resolution as the builders consume it.

    Paths only, no text words: the dispatcher has split the command line
    before a builder runs, and every backend resolver takes PathSpec.
    The union this used to carry is the argv type (workspace/expand),
    where a word really can be either, leaking one layer down.
    """

    def __call__(self,
                 accessor: Any,
                 paths: Sequence[PathSpec],
                 /,
                 index: IndexCacheStore = ...) -> Awaitable[list[PathSpec]]:
        ...


class BuilderFn(Protocol):
    """Builder body: a CommandFn with the backend's ops bound in front."""

    def __call__(self, ops: "CommandIO", accessor: Any, paths: list[PathSpec],
                 texts: list[str],
                 opts: CommandOpts) -> Awaitable[CommandFnResult]:
        ...


AggregateFn = Callable[[list[tuple[str, bytes]]], Awaitable[bytes]]


async def overlaid_stat(stat: OperationFn, overlay: StatOverlay,
                        path: PathSpec, index: IndexCacheStore) -> FileStat:
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
    _refuse_hidden(path, create=False)
    return overlay(path.virtual, await stat(path, index))


def _refuse_hidden(path: PathSpec, create: bool) -> None:
    """Refuse a hidden path the way nonexistence would.

    ENOENT for anything acting on the path, EACCES when the caller is
    creating it (ENOENT is nonsense as the answer to a create). Raised
    at the op boundary so each command renders the refusal through its
    own missing-file wording, indistinguishable from a real miss.

    Args:
        path (PathSpec): the operand being guarded.
        create (bool): whether the op creates the path it names.
    """
    if path_allowed(path.virtual):
        return
    if create:
        raise PermissionError(errno.EACCES, os.strerror(errno.EACCES),
                              path.virtual)
    raise FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT),
                            path.virtual)


def _guarded_call(fn: OperationFn, create: bool, *args: Any,
                  **kwargs: Any) -> Any:
    """Call a backend op after guarding its PathSpec positionals.

    Sync on purpose: the guard raises at call time and the backend's
    own return shape (coroutine, async iterator) passes through
    untouched. The first path refuses as the op's subject (ENOENT, or
    EACCES for a create); any further path is a destination, which a
    hidden target always refuses as EACCES (rename/copy into hidden
    space is a create).

    Args:
        fn (OperationFn): the raw backend op.
        create (bool): whether the op creates its first path.
        *args: the call's positionals, PathSpecs among them.
        **kwargs: forwarded untouched.
    """
    first = True
    for arg in args:
        if isinstance(arg, PathSpec):
            _refuse_hidden(arg, create=create if first else True)
            first = False
    return fn(*args, **kwargs)


async def _guarded_readdir(fn: OperationFn, *args: Any,
                           **kwargs: Any) -> list[str]:
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
    return [
        e for e in entries
        if path_allowed(f"{base}/{e.rstrip('/').rsplit('/', 1)[-1]}")
    ]


def _move_would_reveal(src: PathSpec, dst: PathSpec) -> bool:
    """Whether the session's hides make this relocation a reveal.

    Args:
        src (PathSpec): the subtree being moved or copied.
        dst (PathSpec): where it would land.
    """
    sess = get_current_session()
    if sess is None:
        return False
    return move_reveals(sess.hidden_paths, sess.shown_paths, src.virtual,
                        dst.virtual)


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
        raise PermissionError(errno.EACCES, os.strerror(errno.EACCES),
                              src.virtual)


async def _pair_src_is_dir(stat: StatOp, accessor: Any, src: PathSpec) -> bool:
    """Whether a pair op's source stats as a directory.

    Args:
        stat (StatOp): the backend stat, for classifying the source.
        accessor (Any): the pair call's leading accessor.
        src (PathSpec): the source being classified.
    """
    try:
        row = await stat(accessor, src)
    except FileNotFoundError:
        # Nothing moves; the op itself reports the absence.
        return False
    except OSError:
        # Unanswerable classification fails toward refusal.
        return True
    return row.type is FileType.DIRECTORY


async def _guarded_pair(fn: OperationFn, stat: StatOp, assume_dir: bool, *args:
                        Any, **kwargs: Any) -> Any:
    """Rename/dir-copy guard: ``_guarded_call``'s per-path checks, then
    the subtree reveal check on the (src, dst) pair.

    Only a directory source can carry hidden content into view, so a
    rename whose source stats as a file passes; a dir-copy source is a
    directory by contract and skips the probe.

    Args:
        fn (OperationFn): the raw backend op.
        stat (StatOp): the raw backend stat, probed only when the
            reveal check trips.
        assume_dir (bool): the slot's contract already makes the source
            a directory (dir_copy), so no probe is needed.
        *args: the call's positionals, source then destination among
            them.
        **kwargs: forwarded untouched.
    """
    specs = [arg for arg in args if isinstance(arg, PathSpec)]
    for position, spec in enumerate(specs):
        _refuse_hidden(spec, create=position > 0)
    reveal = len(specs) >= 2 and _move_would_reveal(specs[0], specs[1])
    if reveal and (assume_dir
                   or await _pair_src_is_dir(stat, args[0], specs[0])):
        raise PermissionError(errno.EACCES, os.strerror(errno.EACCES),
                              specs[0].virtual)
    return await fn(*args, **kwargs)


@dataclass(frozen=True, slots=True)
class _SlotChannel:
    """The command plane's remnant channel: the refused rmdir's sibling
    slots, still mode- and rule-guarded but below the visibility
    filter, so the cascade can see what it must destroy while every
    deletion still answers for its own path's mode.

    Args:
        lead (tuple): the call's leading positionals (the accessor).
        index (IndexCacheStore): the invocation's cache index.
        readdir_fn (OperationFn): the sibling readdir slot.
        stat_fn (OperationFn): the sibling stat slot.
        unlink_fn (OperationFn): the sibling unlink slot.
        rmdir_fn (OperationFn): the raw rmdir the guard wraps.
    """

    lead: tuple[Any, ...]
    index: IndexCacheStore
    readdir_fn: OperationFn
    stat_fn: OperationFn
    unlink_fn: OperationFn
    rmdir_fn: OperationFn

    async def readdir(self, spec: PathSpec) -> list[str]:
        entries: list[str] = await self.readdir_fn(*self.lead,
                                                   spec,
                                                   index=self.index)
        return entries

    async def stat(self, spec: PathSpec) -> FileStat:
        row: FileStat = await self.stat_fn(*self.lead, spec, index=self.index)
        return row

    async def unlink(self, spec: PathSpec) -> None:
        await self.unlink_fn(*self.lead, spec)

    async def rmdir(self, spec: PathSpec) -> None:
        await self.rmdir_fn(*self.lead, spec, index=self.index)


async def _guarded_rmdir(fn: OperationFn,
                         readdir: OperationFn,
                         stat: StatOp,
                         unlink: OperationFn | None,
                         children: ChildMounts | None,
                         *args: Any,
                         index: IndexCacheStore = NULL_INDEX,
                         **kwargs: Any) -> Any:
    """rmdir that removes a directory the session sees as empty.

    The backend refuses a directory still holding entries, but when
    every remaining entry is hidden the refusal would leak that
    something invisible exists, so the remnants go with the directory:
    a session's mutation may destroy what it cannot see, never learn of
    it. Any visible child keeps the refusal, and a backend with no
    unlink keeps it too, having no way to take the remnants. The
    removal is the shared ``remove_remnants`` walk over the sibling
    slots, which revalidates visibility before every deletion and
    keeps the mode guard on each one; any cascade failure answers with
    the backend's original refusal, exactly as the ops plane does.

    Args:
        fn (OperationFn): the raw backend rmdir.
        readdir (OperationFn): the raw backend readdir, for the real
            listing the visible/hidden split is judged on.
        stat (StatOp): the raw backend stat, classifying walked entries.
        unlink (OperationFn | None): the raw backend unlink.
        children (ChildMounts | None): child names the namespace owes
            the directory (nested mount roots and symlinks), captured
            from ``glob_children`` at wrap time, which holds the
            invocation's fact because the factory applies this guard
            per invocation, after stamping it. The children join the
            emptiness judgment, never the walk: a visible mounted
            child keeps the refusal exactly as the ops plane's merged
            listing does, while the cascade itself only ever removes
            what the backend holds.
        *args: the call's positionals; the first PathSpec is the
            directory.
        index (IndexCacheStore): the invocation's cache index, threaded
            by the callers so the fallback listing resolves on an
            indexed backend the way the command's own listings did.
        **kwargs: forwarded untouched.
    """
    target: PathSpec | None = None
    for arg in args:
        if isinstance(arg, PathSpec):
            _refuse_hidden(arg, create=False)
            if target is None:
                target = arg
    try:
        return await fn(*args, index=index, **kwargs)
    except OSError as exc:
        if (target is None or unlink is None
                or exc.errno not in (errno.ENOTEMPTY, errno.EEXIST)
                or not hidden_paths_intersect(target.virtual)):
            raise
        lead: list[Any] = []
        for arg in args:
            if isinstance(arg, PathSpec):
                break
            lead.append(arg)
        # Both folds catch ``Exception``, not just ``OSError``: an API
        # backend's failure is not always an errno (box raises its own
        # error type), and a raw backend exception here would reveal
        # exactly what the refusal exists to hide. Cancellation and
        # system exits still propagate.
        try:
            entries = await readdir(*lead, target, index=index)
        except Exception as listing:
            raise exc from listing
        merged = list(entries)
        if children is not None:
            merged.extend(children(target.virtual))
        if not entries or visible_below(target.virtual, merged, path_allowed):
            raise
        channel = _SlotChannel(tuple(lead), index, readdir, stat, unlink, fn)
        try:
            await remove_remnants(channel, path_allowed, target)
        except Exception as cascade:
            raise exc from cascade
        return None


async def _guarded_exists(fn: OperationFn, *args: Any, **kwargs: Any) -> bool:
    """Exists that answers False for a hidden path, never a refusal.

    Args:
        fn (OperationFn): the raw backend exists.
        *args: the call's positionals; the first PathSpec is probed.
        **kwargs: forwarded untouched.
    """
    probed = next(a for a in args if isinstance(a, PathSpec))
    if not path_allowed(probed.virtual):
        return False
    return bool(await fn(*args, **kwargs))


@overload
def bound_op(fn: OperationFn, accessor: Accessor,
             index: IndexCacheStore) -> OperationFn:
    ...


@overload
def bound_op(fn: None, accessor: Accessor, index: IndexCacheStore) -> None:
    ...


def bound_op(fn: OperationFn | None, accessor: Accessor,
             index: IndexCacheStore) -> OperationFn | None:
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
    RENAME = "rename"
    COPY = "copy"
    TRUNCATE = "truncate"


@dataclass(frozen=True, slots=True)
class DuOps:
    """A backend's native ``du`` implementation, both halves at once.

    ``size`` and ``entries`` are not independent: the generic derives its
    per-directory rows from ``entries``, so a backend offering only the
    cheaper ``size`` would silently print operand totals with no
    directory rows and an inert ``-a``. Pairing them in one value makes
    native du all-or-nothing, so that degraded shape cannot be reached
    by omission.

    Args:
        size (DuSizeOp): recursive byte total for one path.
        entries (DuEntriesOp): per-file breakdown, leaf files only.
    """

    size: DuSizeOp
    entries: DuEntriesOp


@dataclass(frozen=True)
class Builder:
    name: str
    fn: BuilderFn
    provision: Callable[[StatOp], ProvisionFn] | None = None
    write: bool = False
    aggregate: AggregateFn | None = None
    read: bool = False
    requirements: frozenset[Operation] = frozenset()


@dataclass(frozen=True)
class CommandIO:
    readdir: ReaddirOp
    read_bytes: ReadBytesOp
    read_stream: ReadStreamOp
    stat: StatOp
    is_mounted: IsMountedOp
    local: bool = True
    max_glob_matches: int | None = DEFAULT_MAX_GLOB_MATCHES
    # Fetch a byte range without pulling the whole object. Absent means
    # the generic read fetches everything and slices, which is correct
    # everywhere and is the only meaningful behavior for a backend that
    # renders its content rather than storing it: there is no remote
    # range to ask for when the bytes do not exist until we make them.
    # Called as (accessor, path, index, offset, size), so most backends
    # point it at their own read_bytes, which already takes the window;
    # disk needs a separate function because its read_bytes does not.
    read_range: ReadRangeOp | None = None
    write: WriteOp | None = None
    exists: ExistsOp | None = None
    mkdir: MkdirOp | None = None
    unlink: PathOp | None = None
    rmdir: RmdirOp | None = None
    rm_r: RmTreeOp | None = None
    rename: PairOp | None = None
    copy: PairOp | None = None
    dir_copy: PairOp | None = None
    create: PathOp | None = None
    truncate: TruncateOp | None = None
    # Filter kwargs drift per backend (name/type/size bounds/...), the
    # repo's kwargs spelling of TS's FindOptions object; a Protocol
    # naming them would reject every backend, so the slot stays loose.
    find: OperationFn | None = None
    du: DuOps | None = None
    max_du_entries: int | None = DEFAULT_MAX_DU_ENTRIES
    # Typed like `write`, now that the tee generic actually calls it.
    append: WriteOp | None = None
    # Kwargs vary per backend (mode/times/owner); loose like TS's any.
    set_attrs: OperationFn | None = None
    # Child names the namespace owes a directory (nested mount roots and
    # symlinks). Stamped per invocation from opts.ns.child_mounts by the
    # factory, because it is session-scoped state and the adapter itself
    # is built once per backend.
    glob_children: ChildMounts | None = None
    # What an owed name points at, the namespace's own stat resolved
    # through the workspace. Stamped beside glob_children from
    # opts.ns.links, so a trailing-slash glob follows a link the way
    # bash does instead of keeping every link it cannot see through.
    glob_target_stat: LinkTargetStat | None = None

    @property
    def resolve_glob(self) -> ResolveGlobOp:
        return make_resolve_glob(self.readdir, self.max_glob_matches,
                                 self.glob_children, self.stat,
                                 self.glob_target_stat)

    def operation(self, op: Operation) -> OperationFn | None:
        operations = {
            Operation.WRITE: self.write,
            Operation.EXISTS: self.exists,
            Operation.MKDIR: self.mkdir,
            Operation.UNLINK: self.unlink,
            Operation.RMDIR: self.rmdir,
            Operation.RENAME: self.rename,
            Operation.COPY: self.copy,
            Operation.TRUNCATE: self.truncate,
        }
        return operations[op]

    def supports(self, requirements: frozenset[Operation]) -> bool:
        return all(self.operation(op) is not None for op in requirements)

    def require(self, op: Operation) -> OperationFn:
        """Return an optional backend op, raising if the backend omits it.

        Builders wire write-side ops (write/mkdir/unlink/rename/...) that
        are ``None`` on read-only backends into generic commands that
        require them. This surfaces the missing capability as a clear
        error instead of a ``NoneType is not callable`` crash.

        Args:
            op (Operation): Required backend operation.
        """
        fn = self.operation(op)
        if fn is None:
            raise NotImplementedError(
                f"operation {op!r} is not supported on this backend")
        return fn


_GUARD_ENOENT_SLOTS = ("read_bytes", "read_stream", "stat", "read_range",
                       "set_attrs", "unlink", "rm_r", "truncate", "copy",
                       "find")

_GUARD_EACCES_SLOTS = ("write", "mkdir", "append", "create")


def with_hidden_guard(ops: CommandIO) -> CommandIO:
    """Return ``ops`` whose slots refuse hidden paths like missing ones.

    The commands factory applies this to every generic command, per
    invocation and after stamping ``glob_children``, so a guard that
    consumes a namespace fact captures the invocation's value at wrap
    time (the rmdir guard's emptiness judgment does); enforcement
    still lands once for the whole command tier (resolve_glob derives
    from the wrapped readdir). The module-level IO constants stay raw:
    the ops tables built from them serve the dispatcher, which
    enforces hiding itself at the door, and their tests introspect
    slot identity. The guards read the current session at call time.

    Args:
        ops (CommandIO): the backend's IO adapter.
    """
    changes: dict[str, Any] = {
        "readdir": functools.partial(_guarded_readdir, ops.readdir)
    }
    for slot in _GUARD_ENOENT_SLOTS:
        fn = getattr(ops, slot)
        if fn is not None:
            changes[slot] = functools.partial(_guarded_call, fn, False)
    for slot in _GUARD_EACCES_SLOTS:
        fn = getattr(ops, slot)
        if fn is not None:
            changes[slot] = functools.partial(_guarded_call, fn, True)
    for slot, assume_dir in (("rename", False), ("dir_copy", True)):
        fn = getattr(ops, slot)
        if fn is not None:
            changes[slot] = functools.partial(_guarded_pair, fn, ops.stat,
                                              assume_dir)
    if ops.rmdir is not None:
        changes["rmdir"] = functools.partial(_guarded_rmdir, ops.rmdir,
                                             ops.readdir, ops.stat, ops.unlink,
                                             ops.glob_children)
    if ops.exists is not None:
        changes["exists"] = functools.partial(_guarded_exists, ops.exists)
    return replace(ops, **changes)


_RULE_SLOTS = ("read_bytes", "read_stream", "read_range", "write", "append",
               "create", "truncate", "set_attrs", "mkdir", "unlink", "rmdir",
               "rm_r", "rename", "copy", "dir_copy")


def _rule_call(fn: OperationFn, *args: Any, **kwargs: Any) -> Any:
    """Call a backend op after asking the admitted command's gate about
    each PathSpec positional (a rename or copy has two, and a refused
    destination is as much a refusal as a refused source).

    Sync on purpose, like ``_guarded_call``: the gate raises at call
    time and the op's own return shape passes through untouched. With
    no gate bound (no admitted command in this context) the op runs as
    is.

    Args:
        fn (OperationFn): the raw backend op.
        *args: the call's positionals, PathSpecs among them.
        **kwargs: forwarded untouched.
    """
    gate = get_admission()
    if gate is not None:
        for arg in args:
            if isinstance(arg, PathSpec):
                gate.check(arg.virtual)
    return fn(*args, **kwargs)


# slot -> (skip_first, subtree): whether the leading PathSpec is a
# read-only source (the copy slots), and whether the op mutates the
# whole subtree under its written paths in one backend call.
_MODE_SLOTS: dict[str, tuple[bool, bool]] = {
    "write": (False, False),
    "mkdir": (False, False),
    "append": (False, False),
    "create": (False, False),
    "truncate": (False, False),
    "unlink": (False, False),
    "rmdir": (False, False),
    "set_attrs": (False, False),
    "rm_r": (False, True),
    "rename": (False, True),
    "copy": (True, False),
    "dir_copy": (True, True),
}


def _mode_call(fn: OperationFn, skip_first: bool, subtree: bool, *args: Any,
               **kwargs: Any) -> Any:
    """Call a backend mutation op after holding each written path to
    its region's effective mode.

    The write-command gate admits a command when any shown subtree
    grants writes, so each individual write must still answer for its
    own path: ``mkdir /repo/private/x`` on a mount whose only writable
    region is ``/repo/build`` refuses here. A copy's source is a read,
    so the first PathSpec is skipped for the copy slots; a rename
    mutates both endpoints, so both are held. An op that covers a
    whole subtree also answers for the regions below its operand
    (``readonly_below``): a native ``rm -r`` would otherwise delete a
    read-only carve-out in one backend call no per-path check ever
    sees. Sync like ``_guarded_call``, and inert with no mount bound
    (a generic invoked outside a mount's command).

    Args:
        fn (OperationFn): the raw backend op.
        skip_first (bool): whether the first PathSpec is read-only
            (the copy slots' source).
        subtree (bool): whether the op mutates everything under its
            written paths in one call.
        *args: the call's positionals, PathSpecs among them.
        **kwargs: forwarded untouched.
    """
    gate = get_mount_gate()
    if gate is not None:
        prefix, mode = gate
        specs = [arg for arg in args if isinstance(arg, PathSpec)]
        for spec in (specs[1:] if skip_first else specs):
            if effective_path_mode(spec.virtual, prefix,
                                   mode) == MountMode.READ:
                raise ReadOnlyError(errno.EROFS, "Read-only file system",
                                    spec.virtual)
            if subtree:
                blame = readonly_below(spec.virtual, prefix, mode)
                if blame is not None:
                    raise ReadOnlyError(errno.EROFS, "Read-only file system",
                                        blame)
    return fn(*args, **kwargs)


def with_mode_guard(ops: CommandIO) -> CommandIO:
    """Return ``ops`` whose mutation slots hold each written path to
    its region's effective mode.

    The per-path half of the mount's write gate, innermost of the three
    guards: hides answer ENOENT first, rules refuse next, and only a
    path both leave standing is judged for its mode, the same order the
    op door applies. Reads are never wrapped, because ``READ`` allows
    them everywhere the other guards do.

    Args:
        ops (CommandIO): the backend's IO adapter.
    """
    changes: dict[str, Any] = {}
    for slot, (skip_first, subtree) in _MODE_SLOTS.items():
        fn = getattr(ops, slot)
        if fn is not None:
            changes[slot] = functools.partial(_mode_call, fn, skip_first,
                                              subtree)
    return replace(ops, **changes)


def with_rule_guard(ops: CommandIO) -> CommandIO:
    """Return ``ops`` whose content and mutation slots ask the admitted
    command's gate before touching a path.

    The rule arms' counterpart of ``with_hidden_guard``, wrapped inside
    it so a hidden path still answers ENOENT before any rule can name
    it. The gate judged the line's operands; this is how a walk (``grep
    -r``, ``find``, ``du``, ``cp -r``, ``tar``) is held to the same rules
    on the entries it reaches below them. ``stat`` and ``exists`` stay
    unguarded, because deny means present and refused, not absent: a
    listing shows a refused entry's name and size, and the read of it
    is what fails, as GNU reports an unreadable file. ``readdir`` asks
    about the directory being listed, never filters its names. A
    backend's native ``find``/``du`` are not wrapped: the builders
    route to the readdir walk while a path rule scopes the command
    (``path_rules_active``), so every entry passes through here.

    Args:
        ops (CommandIO): the backend's IO adapter.
    """
    changes: dict[str, Any] = {
        "readdir": functools.partial(_rule_call, ops.readdir)
    }
    for slot in _RULE_SLOTS:
        fn = getattr(ops, slot)
        if fn is not None:
            changes[slot] = functools.partial(_rule_call, fn)
    return replace(ops, **changes)


def with_path_guards(ops: CommandIO) -> CommandIO:
    """Return ``ops`` under the whole path axis: hides answer ENOENT
    first, rules refuse next, the mode speaks last.

    The one spelling of the guard chain, used by the commands factory
    for every generic command and by a bespoke command family that
    consumes a ``CommandIO`` directly (the object-store overrides), so
    an override enforces the session's path axis exactly like the
    generic it replaces.

    Args:
        ops (CommandIO): the backend's IO adapter.
    """
    return with_hidden_guard(with_rule_guard(with_mode_guard(ops)))


def with_write_guards(fn: OperationFn) -> OperationFn:
    """Guard one bare backend write the way the adapter guards a slot.

    For a bespoke command wired from loose functions rather than a
    ``CommandIO`` (the google ``rm`` family binds an index-threaded
    unlink): the same chain in the same order, judging the call's
    PathSpec positionals. A hidden path answers ENOENT, the flavor of
    the flat mutation slots. The policy arm rides outermost, as it does
    on the slot chain.

    Args:
        fn (OperationFn): the raw backend write.
    """
    guarded: OperationFn = functools.partial(_mode_call, fn, False, False)
    guarded = functools.partial(_rule_call, guarded)
    guarded = functools.partial(_guarded_call, guarded, False)
    return functools.partial(_policy_call, _UNBOUND_SCOPE, guarded, "unlink",
                             True, False)


# slot -> (write, first_is_source): whether the op mutates its PathSpec
# positionals, and whether the leading one is a read-only source (the
# copy slots), mirroring _MODE_SLOTS' skip_first. The surface is the
# rule guard's (_RULE_SLOTS); stat/exists and the native find/du slots
# stay unguarded as presence facts, and readdir/read_stream have their
# own wrappers below.
_POLICY_SLOTS: dict[str, tuple[bool, bool]] = {
    "read_bytes": (False, False),
    "read_range": (False, False),
    "write": (True, False),
    "append": (True, False),
    "create": (True, False),
    "truncate": (True, False),
    "set_attrs": (True, False),
    "mkdir": (True, False),
    "unlink": (True, False),
    "rmdir": (True, False),
    "rm_r": (True, False),
    "rename": (True, False),
    "copy": (True, True),
    "dir_copy": (True, True),
}

# (policies, mount prefix, session id); the unbound spelling for a
# registration-time wrap, which reads the live context per call.
_PolicyScope = tuple[Policies | None, str, str]
_UNBOUND_SCOPE: _PolicyScope = (None, "", "")


def _op_policy_scope() -> _PolicyScope:
    """The policies to consult for this op call, the mount prefix, and
    the session the command runs under.

    None is the fast path: no dispatched command bound policies, or
    none of them override pre_ops, at the cost of two contextvar reads
    and one O(1) probe per slot call.
    """
    policies = get_op_policies()
    if policies is None or not policies.wants("pre_ops"):
        return _UNBOUND_SCOPE
    gate = get_mount_gate()
    sess = get_current_session()
    return (policies, gate[0] if gate is not None else "",
            sess.session_id if sess is not None else "")


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


async def _policy_admit(policies: Policies, prefix: str, session_id: str,
                        op: str, write: bool, first_source: bool,
                        args: tuple[Any, ...]) -> None:
    """Fire pre_ops for each PathSpec positional of one slot call.

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
            await pre_ops_gate(policies, op, arg, mutates, prefix, session_id)
            first = False


async def _policy_call(scope: _PolicyScope, fn: OperationFn, op: str,
                       write: bool, first_source: bool, *args: Any,
                       **kwargs: Any) -> Any:
    """Call a backend op after admitting its paths through pre_ops.

    Async, unlike the sync guards it wraps: the hooks are user
    coroutines. Every slot this wraps returns an awaitable, so the
    shape is preserved; read_stream and readdir have their own
    wrappers.

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
        await _policy_admit(policies, prefix, session_id, op, write,
                            first_source, args)
    return await fn(*args, **kwargs)


async def _policy_readdir(scope: _PolicyScope, fn: OperationFn, *args: Any,
                          **kwargs: Any) -> list[str]:
    """Readdir admitted through pre_ops for the directory it lists.

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
        await pre_ops_gate(policies, "readdir", parent_spec, False, prefix,
                           session_id)
    entries: list[str] = await fn(*args, **kwargs)
    return entries


def _policy_stream(scope: _PolicyScope, fn: OperationFn, *args: Any,
                   **kwargs: Any) -> Any:
    """Read-stream admitted through pre_ops before the first chunk.

    A plain def for the reason ``_guarded_read_stream`` is one: the
    inner op captures per-call scope eagerly (the read-through cache
    reads the active manager here), so it is built now, which runs no
    I/O; the admission itself is async, so it rides the returned
    generator, before any byte is pulled.

    Args:
        scope (_PolicyScope): the wrap-time capture.
        fn (OperationFn): the guarded backend read_stream.
        *args: the call's positionals; the first PathSpec is the file
            being read.
        **kwargs: forwarded untouched.
    """
    policies, prefix, session_id = _live_policy_scope(scope)
    spec = next((a for a in args if isinstance(a, PathSpec)), None)
    if policies is None or spec is None:
        return fn(*args, **kwargs)
    return _policy_stream_drain(policies, prefix, session_id, spec,
                                fn(*args, **kwargs))


async def _policy_stream_drain(
        policies: Policies, prefix: str, session_id: str, path: PathSpec,
        source: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    """Drain ``source`` once the read is admitted; close it if refused.

    Args:
        policies (Policies): the bound admission policies.
        prefix (str): the executing mount's prefix.
        session_id (str): the session the command runs under.
        path (PathSpec): the file being read.
        source (AsyncIterator[bytes]): the not-yet-started inner stream.
    """
    try:
        await pre_ops_gate(policies, "read_stream", path, False, prefix,
                           session_id)
    except BaseException:
        close = getattr(source, "aclose", None)
        if close is not None:
            await close()
        raise
    async for chunk in source:
        yield chunk


def with_policy_guard(ops: CommandIO) -> CommandIO:
    """Return ``ops`` whose content and mutation slots admit each
    PathSpec through the workspace's coded pre_ops hooks.

    The coded-policy arm of the guard chain, applied outside the cache
    wraps so admission fires before a warm serve, the dispatcher's own
    order. The surface is the rule guard's plus readdir: content reads
    (read_bytes, read_stream, read_range), every mutation slot, and
    the directory a readdir lists. stat/exists and the native find/du
    slots stay unguarded as presence facts, the mode-000 shape the
    rule guard already states, so a denied entry still lists and stats
    while the read of it is what fails. Ops are named by slot; a
    policy portable across the tiers keys on ``write`` and ``path``.
    Inert unless a dispatched command bound policies overriding
    pre_ops (``_op_policy_scope``, with the mount prefix and session
    identity captured at wrap time so a lazily drained reader still
    answers as the command that bound it, see ``_live_policy_scope``).

    Args:
        ops (CommandIO): the backend's IO adapter.
    """
    scope = _op_policy_scope()
    changes: dict[str, Any] = {
        "readdir": functools.partial(_policy_readdir, scope, ops.readdir),
        "read_stream": functools.partial(_policy_stream, scope,
                                         ops.read_stream),
    }
    for slot, (write, first_source) in _POLICY_SLOTS.items():
        fn = getattr(ops, slot)
        if fn is not None:
            changes[slot] = functools.partial(_policy_call, scope, fn, slot,
                                              write, first_source)
    return replace(ops, **changes)


async def _is_implicit_dir(ops: CommandIO, accessor: Accessor, path: PathSpec,
                           index: IndexCacheStore) -> bool:
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
    key = path.resource_path.strip("/")
    if not key:
        try:
            entries = await ops.readdir(accessor, path, index)
        except MISS_ERRORS:
            return False
        return bool(entries)
    parent_key = key.rsplit("/", 1)[0] if "/" in key else ""
    parent_virtual = parent(target)
    parent_path = PathSpec(virtual=parent_virtual,
                           directory=parent_virtual,
                           resource_path=parent_key)
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
    live in another resource, so the mount this command is bound to can
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


async def _read_hit_a_dir(ops: CommandIO, accessor: Accessor,
                          index: IndexCacheStore, path: PathSpec,
                          exc: BaseException) -> bool:
    """Whether a read that already failed was really a read of a directory.

    Asked only after the read raised, which is what keeps a successful
    read at exactly one backend call. Nothing is lost by waiting: every
    backend raises on a directory read. One that knows says so (gdrive,
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
    in another resource.

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
        exc (BaseException): what the backend raised.
    """
    if isinstance(exc, IsADirectoryError):
        return True
    try:
        st: FileStat | None = await ops.stat(accessor, path, index)
    except Exception:
        # A probe that fails is a negative probe, never an error to
        # surface: `exc` is what the user gets, and it is still live.
        st = None
    if st is not None:
        return getattr(st, "type", None) == FileType.DIRECTORY
    try:
        if await _is_implicit_dir(ops, accessor, path, index):
            return True
    except Exception:
        # Negative probe, as above. `_is_implicit_dir` narrows to
        # MISS_ERRORS for its other caller, where the stat is the
        # operation rather than a probe.
        pass
    # The same fact `_is_namespace_dir` reads, reached from the adapter
    # rather than from the bag: this guard wraps a slot and never sees a
    # CommandOpts, and the factory stamps the very callable
    # `opts.ns.child_mounts` would hand over.
    return bool(ops.glob_children is not None
                and ops.glob_children(path.virtual))


async def _drain_refusing_dirs(
        ops: CommandIO, accessor: Accessor, index: IndexCacheStore,
        path: PathSpec, source: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    try:
        async for chunk in source:
            yield chunk
    except Exception as exc:
        if await _read_hit_a_dir(ops, accessor, index, path, exc):
            raise eisdir(path) from None
        raise


def _guarded_read_stream(ops: CommandIO,
                         fn: OperationFn,
                         accessor: Accessor,
                         path: PathSpec,
                         index: IndexCacheStore = NULL_INDEX,
                         **kwargs: Any) -> AsyncIterator[bytes]:
    # A plain def, for the reason `cache_aware_read_stream`'s reader is
    # one: the wrapped op may capture per-call scope, and the
    # read-through cache reads the active CacheManager here. An async
    # generator would defer that call to drain time, when the mount's
    # cache-manager scope is already gone, so every warm read missed.
    return _drain_refusing_dirs(ops, accessor, index, path,
                                fn(accessor, path, index, **kwargs))


async def _guarded_read(ops: CommandIO,
                        fn: OperationFn,
                        accessor: Accessor,
                        path: PathSpec,
                        index: IndexCacheStore = NULL_INDEX,
                        **kwargs: Any) -> bytes:
    try:
        data: bytes = await fn(accessor, path, index, **kwargs)
    except Exception as exc:
        if await _read_hit_a_dir(ops, accessor, index, path, exc):
            raise eisdir(path) from None
        raise
    return data


def with_dir_guard(ops: CommandIO) -> CommandIO:
    """Return ``ops`` whose reads refuse a directory with GNU's EISDIR.

    The read family's counterpart of ``with_hidden_guard`` and
    ``with_slash_guard``: reading a directory is never a legitimate call,
    so the refusal belongs to the slot rather than to each builder's
    wiring. It used to belong to the wiring, and 23 of the read builders
    passed a bare ``bound_op(ops.read_stream, ...)`` instead, so a
    directory on a keyed backend reported ENOENT.

    Refined after the failure, never before it, so a read that succeeds
    costs exactly what it did. The refusal is built from the operand's
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
        wrapper = (_guarded_read_stream
                   if slot == "read_stream" else _guarded_read)
        changes[slot] = functools.partial(wrapper, ops, fn)
    return replace(ops, **changes)


async def _stat_refusing_dirs(ops: CommandIO, accessor: Accessor,
                              opts: CommandOpts, path: PathSpec) -> FileStat:
    try:
        st: FileStat = await ops.stat(accessor, path, opts.index)
    except FileNotFoundError:
        if await _is_implicit_dir(ops, accessor, path, opts.index):
            raise eisdir(path) from None
        if _is_namespace_dir(opts, path):
            raise eisdir(path) from None
        raise
    if getattr(st, "type", None) == FileType.DIRECTORY:
        raise eisdir(path)
    return st


def dir_aware_stat(ops: CommandIO, accessor: Accessor,
                   opts: CommandOpts) -> OperationFn:
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


async def _stream_refusing_dirs(ops: CommandIO, accessor: Accessor,
                                opts: CommandOpts,
                                path: PathSpec) -> AsyncIterator[bytes]:
    await _stat_refusing_dirs(ops, accessor, opts, path)
    async for chunk in ops.read_stream(accessor, path, opts.index):
        yield chunk


def dir_aware_stream(ops: CommandIO, accessor: Accessor,
                     opts: CommandOpts) -> OperationFn:
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


async def resolve_or_empty(ops: CommandIO, accessor: Accessor,
                           paths: list[PathSpec],
                           index: IndexCacheStore) -> list[PathSpec]:
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
