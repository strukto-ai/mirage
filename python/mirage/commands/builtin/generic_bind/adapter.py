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
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol, overload

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.du import (DEFAULT_MAX_DU_ENTRIES,
                                                DuEntries)
from mirage.commands.config import CommandFnResult, CommandOpts, ProvisionFn
from mirage.ops.types import ChildMounts, StatOverlay
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import MISS_ERRORS, eisdir
from mirage.utils.glob_walk import DEFAULT_MAX_GLOB_MATCHES, make_resolve_glob
from mirage.utils.path import norm, parent

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

    def __call__(self,
                 accessor: Any,
                 paths: Sequence[str | PathSpec],
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
    itself cannot hold.

    Args:
        stat (OperationFn): backend stat ``(path, index) -> FileStat``.
        overlay (StatOverlay): namespace merge ``(virtual, stat) -> stat``.
        path (PathSpec): entry being statted.
        index (IndexCacheStore): cache index threaded through.
    """
    return overlay(path.virtual, await stat(path, index))


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
    rmdir: PathOp | None = None
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
    # symlinks). Stamped per invocation from opts.child_mounts by the
    # factory, because it is session-scoped state and the adapter itself
    # is built once per backend.
    glob_children: ChildMounts | None = None

    @property
    def resolve_glob(self) -> ResolveGlobOp:
        return make_resolve_glob(self.readdir, self.max_glob_matches,
                                 self.glob_children)

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


async def _stat_refusing_dirs(ops: CommandIO, accessor: Accessor,
                              index: IndexCacheStore,
                              path: PathSpec) -> FileStat:
    try:
        st: FileStat = await ops.stat(accessor, path, index)
    except FileNotFoundError:
        if await _is_implicit_dir(ops, accessor, path, index):
            raise eisdir(path) from None
        raise
    if getattr(st, "type", None) == FileType.DIRECTORY:
        raise eisdir(path)
    return st


def dir_aware_stat(ops: CommandIO, accessor: Accessor,
                   index: IndexCacheStore) -> OperationFn:
    """Bound stat for the read-family chokepoint (``split_readable``).

    A directory operand fails with EISDIR instead of succeeding
    (explicit, via the stat type) or failing with ENOENT (implicit
    keyed-backend directory, via a readdir probe), so cat/head/tail
    report GNU's ``Is a directory`` and keep the remaining operands
    (#457). Called as ``stat(path)``; mirrors ``dirAwareStat`` in
    adapter.ts.

    Args:
        ops (CommandIO): Backend I/O bundle providing ``stat``/``readdir``.
        accessor (Accessor): Backend accessor bound into stats.
        index (IndexCacheStore): Index cache store bound into stats.
    """
    return functools.partial(_stat_refusing_dirs, ops, accessor, index)


async def _stream_refusing_dirs(ops: CommandIO, accessor: Accessor,
                                index: IndexCacheStore,
                                path: PathSpec) -> AsyncIterator[bytes]:
    await _stat_refusing_dirs(ops, accessor, index, path)
    async for chunk in ops.read_stream(accessor, path, index):
        yield chunk


def dir_aware_stream(ops: CommandIO, accessor: Accessor,
                     index: IndexCacheStore) -> OperationFn:
    """Bound read stream for the per-operand chokepoint (``read_operands``).

    The operand is stat'ed first so a directory fails with EISDIR before
    any backend read runs (sftp reads of a directory raise an opaque
    ``Failure``, not ENOENT), and an ENOENT for an implicit keyed-backend
    directory is refined the same way ``dir_aware_stat`` does, before the
    generic formats the stderr line (#457). Called as ``read(path)``;
    mirrors ``dirAwareStream`` in adapter.ts.

    Args:
        ops (CommandIO): Backend I/O bundle providing ``stat``/``readdir``
            and ``read_stream``.
        accessor (Accessor): Backend accessor bound into reads.
        index (IndexCacheStore): Index cache store bound into reads.
    """
    return functools.partial(_stream_refusing_dirs, ops, accessor, index)
