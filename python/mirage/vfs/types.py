from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Mapping,
    Sequence,
)
from dataclasses import dataclass, field
from enum import StrEnum
from typing import (
    TYPE_CHECKING,
    Any,
    NamedTuple,
    Protocol,
    runtime_checkable,
)

from mirage.cache.index import IndexCacheStore
from mirage.io.types import ByteSource
from mirage.types import FileStat, JsonValue, PathSpec

if TYPE_CHECKING:
    pass

DuEntries = tuple[list[tuple[str, int]], int]


class Effect(StrEnum):
    """What a dispatchable VFS function does to the mount.

    READ returns content and METADATA an entry's metadata; neither
    changes the mount. WRITE changes a file's bytes, CREATE makes a name
    that must not exist yet, REMOVE drops a name, RENAME moves one with
    everything under it, COPY makes its ``dst`` hold what its path holds,
    and ATTR changes an entry's metadata. Every effect but READ and
    METADATA is a write: a read-only mount refuses the call and admission
    judges it as one. A COPY reads its path and writes only its ``dst``.
    """

    READ = "read"
    METADATA = "metadata"
    WRITE = "write"
    CREATE = "create"
    REMOVE = "remove"
    RENAME = "rename"
    COPY = "copy"
    ATTR = "attr"


class Target(StrEnum):
    """What kind of entry a dispatchable function's path names."""

    FILE = "file"
    DIR = "dir"
    LINK = "link"
    ANY = "any"


class VfsCall(NamedTuple):
    """What ``vfs_call`` declares for one function, and what a ``pre_vfs``
    / ``post_vfs`` method sees of the call.

    Args:
        name (str): the function's name (``read``, ``search``, ...).
        effect (Effect): what the call does to the mount.
        target (Target): the kind of entry its path names.
        creates (bool): a WRITE that makes a missing file, as open(2)
            with O_CREAT.
        subtree (bool): the call reaches everything below its paths, as
            a rename, a tree removal or a tree copy does.
    """

    name: str
    effect: Effect
    target: Target
    creates: bool
    subtree: bool = False


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
    the dir-refusing chokepoint ``async for``s over this directly."""

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


class SetAttrsOp(Protocol):
    def __call__(
        self,
        accessor: Any,
        path: PathSpec,
        /,
        *,
        mode: int | None = ...,
        uid: int | str | None = ...,
        gid: int | str | None = ...,
        atime: str | None = ...,
        mtime: str | None = ...,
    ) -> Awaitable[dict[str, int | str]]: ...


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


class ScanReason(StrEnum):
    """Why grep or rg reads every file instead of asking the mount.

    NO_SEARCH: no ``files_containing`` or ``lines_containing`` on the
    mount, or a hide or path rule covers the walk. NO_TEXT: -f, or no
    plain text of three characters that every match holds (under -i, a
    word with a non-ASCII letter, or with i, k or s when case folds by
    Unicode, counts as none). EVERY_LINE: -v or rg --passthru prints
    lines that do not match. EVERY_FILE: rg --files-without-match, or
    rg -c or --count-matches with --include-zero, without -q, lists
    files that do not match, and rg leaves a binary one out; rg --stats
    and --json count them. LINKS: rg -L follows
    links out of the walk. BINARY: -a, --binary-files=text, rg -a,
    --binary or -uuu reads every binary-extension file, which a search
    that answered does not rule out. TRANSFORMED: rg -z, --pre or -E
    naming an encoding searches bytes the mount does not store.
    UNANSWERED: ``files_containing`` returned None, or
    ``lines_containing`` returned None for a file.
    """

    NO_SEARCH = "the mount has no search"
    NO_TEXT = "the pattern has no plain text to search for"
    EVERY_LINE = "the output needs lines that do not match"
    EVERY_FILE = "the output lists files that do not match"
    LINKS = "links are followed"
    BINARY = "binary files are read"
    TRANSFORMED = "the bytes searched are not the bytes stored"
    UNANSWERED = "the search could not answer"


class FilesContainingOp(Protocol):
    """Files under ``under`` whose content may contain ``text``; None
    when the search cannot answer for every file."""

    def __call__(
        self,
        accessor: Any,
        text: str,
        under: list[PathSpec],
        /,
        *,
        whole_word: bool,
        ignore_case: bool,
        index: IndexCacheStore = ...,
    ) -> Awaitable[list[PathSpec] | None]: ...


class LinesContainingOp(Protocol):
    """The lines of ``path`` that may contain ``text``, in file order,
    whole or streamed; None when the search cannot answer for this
    file."""

    def __call__(
        self,
        accessor: Any,
        path: PathSpec,
        text: str,
        /,
        *,
        ignore_case: bool,
        index: IndexCacheStore = ...,
    ) -> Awaitable[ByteSource | None]: ...


class BeforeFullScanOp(Protocol):
    """Called before grep or rg reads a file no search answered; raise
    to refuse."""

    def __call__(
        self,
        accessor: Any,
        command: str,
        under: list[PathSpec],
        reason: ScanReason,
        /,
        index: IndexCacheStore = ...,
    ) -> Awaitable[None]: ...


class FirstLinesOp(Protocol):
    """The first ``n`` lines of ``path``; None when the file is to be
    read."""

    def __call__(
        self,
        accessor: Any,
        path: PathSpec,
        n: int,
        /,
        index: IndexCacheStore = ...,
    ) -> Awaitable[bytes | None]: ...


class LastLinesOp(Protocol):
    """The last ``n`` lines of ``path``; None when the file is to be
    read."""

    def __call__(
        self,
        accessor: Any,
        path: PathSpec,
        n: int,
        /,
        index: IndexCacheStore = ...,
    ) -> Awaitable[bytes | None]: ...


class LineCountOp(Protocol):
    """How many lines ``path`` holds; None when the file is to be read."""

    def __call__(
        self,
        accessor: Any,
        path: PathSpec,
        /,
        index: IndexCacheStore = ...,
    ) -> Awaitable[int | None]: ...


class ReadTreeOp(Protocol):
    """Every entry under ``path``, keyed by its path below it; None when
    the directory is to be walked."""

    def __call__(
        self,
        accessor: Any,
        path: PathSpec,
        maxdepth: int | None = ...,
        /,
        index: IndexCacheStore = ...,
    ) -> Awaitable[dict[str, FileStat] | None]: ...


class FollowOp(Protocol):
    """The lines added to ``path`` from now on; None when the file is to
    be polled."""

    def __call__(
        self,
        accessor: Any,
        path: PathSpec,
        /,
        index: IndexCacheStore = ...,
    ) -> Awaitable[AsyncIterator[bytes] | None]: ...


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


class SearchOp(Protocol):
    """Search a resource; None declines, [] means no results.

    Results are text records in the backend's declared format. Integrations
    such as grep require an explicit compatibility declaration in metadata.
    Errors and incomplete results must be reported, never treated as misses.
    """

    def __call__(
        self,
        accessor: Any,
        path: PathSpec,
        query: SearchQuery,
        /,
        index: IndexCacheStore = ...,
    ) -> Awaitable[list[str] | None]: ...


class SearchManyOp(Protocol):
    """Search several scopes as one ranked query."""

    def __call__(
        self,
        accessor: Any,
        paths: list[PathSpec],
        query: SearchQuery,
        /,
        index: IndexCacheStore = ...,
    ) -> Awaitable[list[str] | None]: ...


@dataclass(frozen=True, kw_only=True)
class SearchOps:
    """Optional resource search, what the ``search`` command asks.

    Args:
        search (SearchOp): the resource's single-scope search callback.
        search_many (SearchManyOp | None): optional batch ranking.
    """

    search: SearchOp
    search_many: SearchManyOp | None = None


@runtime_checkable
class EndpointVFS(Protocol):
    """A backend that declares the endpoint its writes go to."""

    def resolved_endpoint(self) -> str | None: ...
