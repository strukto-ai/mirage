from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from dataclasses import dataclass, field
from typing import Any, Protocol

from mirage.cache.index import IndexCacheStore
from mirage.types import FileStat, JsonValue, PathSpec

DuEntries = tuple[list[tuple[str, int]], int]

OperationFn = Callable[..., Any]

# Per-slot op shapes, the twins of types.ts's ReaddirOp/StatOp/...
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
    def __call__(
        self, accessor: Any, path: PathSpec, /, index: IndexCacheStore = ...
    ) -> Awaitable[list[str]]: ...


class ReadBytesOp(Protocol):
    def __call__(
        self, accessor: Any, path: PathSpec, /, index: IndexCacheStore = ...
    ) -> Awaitable[bytes]: ...


class ReadStreamOp(Protocol):
    """Backend streams are async iterators; the polymorphic reader
    contract (bytes / awaitable) exists only at the generics' bound-
    reader boundary (``normalized_read``), never on the slot itself:
    the cache wrapper and the dir-refusing chokepoint both ``async
    for`` over this directly."""

    def __call__(
        self, accessor: Any, path: PathSpec, /, index: IndexCacheStore = ...
    ) -> AsyncIterator[bytes]: ...


class StatOp(Protocol):
    def __call__(
        self, accessor: Any, path: PathSpec, /, index: IndexCacheStore = ...
    ) -> Awaitable[FileStat]: ...


class ReadRangeOp(Protocol):
    """A byte window without reading the whole object.

    Called as ``(accessor, path, index, offset, size)``; most backends
    point it at their own ``read_bytes``, which already takes the
    window.
    """

    def __call__(
        self,
        accessor: Any,
        path: PathSpec,
        /,
        index: IndexCacheStore = ...,
        offset: int = ...,
        size: int | None = ...,
    ) -> Awaitable[bytes]: ...


class WriteOp(Protocol):
    def __call__(
        self, accessor: Any, path: PathSpec, data: bytes, /
    ) -> Awaitable[None]: ...


class PwriteOp(Protocol):
    """Write ``data`` at ``offset``, keeping every byte outside it, as
    pwrite(2) does; a gap past the end reads back as zeros and a missing
    file is created."""

    def __call__(
        self, accessor: Any, path: PathSpec, data: bytes, offset: int, /
    ) -> Awaitable[None]: ...


class ExistsOp(Protocol):
    def __call__(
        self, accessor: Any, path: PathSpec, /
    ) -> Awaitable[bool]: ...


class PathOp(Protocol):
    def __call__(
        self, accessor: Any, path: PathSpec, /
    ) -> Awaitable[None]: ...


class RmdirOp(Protocol):
    """Remove an empty directory. ``index`` joins the read-family slots'
    contract because the hidden-remnant guard turns a refused rmdir into
    a raw listing of the same directory, and an indexed backend cannot
    list a nested path through ``NULL_INDEX``; the backend itself does
    not consult it."""

    def __call__(
        self, accessor: Any, path: PathSpec, /, index: IndexCacheStore = ...
    ) -> Awaitable[None]: ...


class RmTreeOp(Protocol):
    """Remove a subtree. The builders ignore any returned value
    (databricks reports the removed keys for its own rename path), so
    the return stays loose where unlink/rmdir pin None."""

    def __call__(self, accessor: Any, path: PathSpec, /) -> Awaitable[Any]: ...


class MkdirOp(Protocol):
    def __call__(
        self, accessor: Any, path: PathSpec, /, parents: bool = ...
    ) -> Awaitable[None]: ...


class PairOp(Protocol):
    """Rename/copy/dir-copy: two paths on the same backend."""

    def __call__(
        self, accessor: Any, src: PathSpec, dst: PathSpec, /
    ) -> Awaitable[None]: ...


class TruncateOp(Protocol):
    """Resize with an optional atomic no-create precondition.

    Backends unable to enforce no-create must raise ENOTSUP before writing.
    """

    def __call__(
        self,
        accessor: Any,
        path: PathSpec,
        length: int,
        no_create: bool = False,
        /,
    ) -> Awaitable[None]: ...


class IsMountedOp(Protocol):
    def __call__(self, accessor: Any, /) -> bool: ...


class DuSizeOp(Protocol):
    def __call__(
        self, accessor: Any, path: PathSpec, /, index: IndexCacheStore = ...
    ) -> Awaitable[int]: ...


class DuEntriesOp(Protocol):
    def __call__(
        self, accessor: Any, path: PathSpec, /, index: IndexCacheStore = ...
    ) -> Awaitable[DuEntries]: ...


class ResolveGlobOp(Protocol):
    """Glob resolution as the builders consume it.

    Paths only, no text words: the dispatcher has split the command line
    before a builder runs, and every backend resolver takes PathSpec.
    The union this used to carry is the argv type (workspace/expand),
    where a word really can be either, leaking one layer down.
    """

    def __call__(
        self,
        accessor: Any,
        paths: Sequence[PathSpec],
        /,
        index: IndexCacheStore = ...,
    ) -> Awaitable[list[PathSpec]]: ...


@dataclass(frozen=True, slots=True)
class DuOps:
    """A backend's native ``du`` implementation, both halves at once.

    ``size`` and ``entries`` are not independent: the generic derives its
    per-directory rows from ``entries``, so a backend offering only the
    cheaper ``size`` would silently print operand totals with no
    directory rows and an inert ``-a``. Pairing them in one value makes
    native du all-or-nothing, so that degraded shape cannot be reached
    by omission.

    A native op answers from one pass over the stored files, so a
    directory holding no file never appears in ``entries`` and gets no
    row, where the shared readdir walk (and GNU) prints its ``0`` row.
    The difference is accepted for the speed and pinned in
    ``integ/unix/du/empty.json``.

    Args:
        size (DuSizeOp): recursive byte total for one path.
        entries (DuEntriesOp): per-file breakdown, leaf files only.
    """

    size: DuSizeOp
    entries: DuEntriesOp


@dataclass(frozen=True, kw_only=True)
class ReadOps:
    """Required resource reads: child paths, rendered bytes, and metadata."""

    readdir: ReaddirOp
    read_bytes: ReadBytesOp
    stat: StatOp


@dataclass(frozen=True, kw_only=True)
class NativeReadOps:
    """Optional read accelerators with the same semantics as generic reads."""

    read_stream: ReadStreamOp | None = None
    read_range: ReadRangeOp | None = None
    exists: ExistsOp | None = None
    find: OperationFn | None = None
    du: DuOps | None = None


@dataclass(frozen=True, kw_only=True)
class WriteOps:
    """Independent mutations; omitted operations remain unsupported."""

    write: WriteOp | None = None
    append: WriteOp | None = None
    pwrite: PwriteOp | None = None
    create: PathOp | None = None
    mkdir: MkdirOp | None = None
    unlink: PathOp | None = None
    rmdir: RmdirOp | None = None
    rm_r: RmTreeOp | None = None
    rename: PairOp | None = None
    copy: PairOp | None = None
    dir_copy: PairOp | None = None
    truncate: TruncateOp | None = None
    set_attrs: OperationFn | None = None


class NarrowPathsOp(Protocol):
    """Files under the scopes that may hold the whole-word literal *query*.

    A superset is harmless, since the scan still runs over the answer;
    None means the index cannot answer and the scan walks everything.
    """

    def __call__(
        self, accessor: Any, query: str, paths: list[PathSpec], /
    ) -> Awaitable[list[PathSpec] | None]: ...


@dataclass(frozen=True, kw_only=True)
class ContentSearchOps:
    """A content index that narrows a recursive grep/rg to candidate files.

    The scan still runs locally over the files it names, so an empty
    answer falls back to the full walk: a search index lags recent writes.

    Args:
        narrow_paths (NarrowPathsOp): candidate files under the scopes.
        enabled (IsMountedOp): whether this mount opted in.
    """

    narrow_paths: NarrowPathsOp
    enabled: IsMountedOp


@dataclass(frozen=True, slots=True)
class SearchQuery:
    """A resource query and its backend-specific arguments.

    Args:
        query (str): the search text, interpreted by the resource.
        options (Mapping[str, JsonValue]): filters, limits, or namespaced
            integration options. The backend validates the keys it supports.
    """

    query: str
    options: Mapping[str, JsonValue] = field(default_factory=dict)


SearchResult = tuple[PathSpec, str]


class SearchOp(Protocol):
    """Search a resource; None declines, [] means no results.

    Each record keeps its canonical file path separate from its rendered text,
    so visibility never depends on parsing backend output. Integrations such
    as grep require an explicit compatibility declaration in metadata.
    Errors and incomplete results must be reported, never treated as misses.
    """

    def __call__(
        self,
        accessor: Any,
        path: PathSpec,
        query: SearchQuery,
        /,
        index: IndexCacheStore = ...,
    ) -> Awaitable[list[SearchResult] | None]: ...


class SearchManyOp(Protocol):
    """Search several scopes as one ranked query."""

    def __call__(
        self,
        accessor: Any,
        paths: list[PathSpec],
        query: SearchQuery,
        /,
        index: IndexCacheStore = ...,
    ) -> Awaitable[list[SearchResult] | None]: ...


@dataclass(frozen=True, kw_only=True)
class SearchOps:
    """Optional resource search with extensible capability metadata.

    Args:
        search (SearchOp): the resource's single-scope search callback.
        search_many (SearchManyOp | None): optional batch ranking.
        meta (Mapping[str, JsonValue]): static capabilities; consumers
            validate their own namespace. No grep compatibility is assumed.
    """

    search: SearchOp
    search_many: SearchManyOp | None = None
    meta: Mapping[str, JsonValue] = field(default_factory=dict)
