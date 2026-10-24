from collections.abc import Awaitable
from dataclasses import dataclass
from enum import StrEnum
from typing import (
    Any,
    NamedTuple,
    Protocol,
    runtime_checkable,
)

from mirage.types import PathSpec, SearchQuery


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


class SearchOp(Protocol):
    """Search a resource; None declines, [] means no results.

    One ``(path, record)`` pair per hit: the hit's virtual path and the
    text record the ``search`` command prints. Errors and incomplete
    results must be reported, never treated as misses.
    """

    def __call__(
        self,
        accessor: Any,
        path: PathSpec,
        query: SearchQuery,
        /,
    ) -> Awaitable[list[tuple[str, str]] | None]: ...


class SearchManyOp(Protocol):
    """Search several scopes as one ranked query."""

    def __call__(
        self,
        accessor: Any,
        paths: list[PathSpec],
        query: SearchQuery,
        /,
    ) -> Awaitable[list[tuple[str, str]] | None]: ...


@dataclass(frozen=True, kw_only=True)
class SearchOps:
    """Optional resource search, what the ``search`` command asks.

    Args:
        search (SearchOp): the resource's single-scope search callback.
        search_many (SearchManyOp): the batch ranking.
    """

    search: SearchOp
    search_many: SearchManyOp


@runtime_checkable
class EndpointVFS(Protocol):
    """A backend that declares the endpoint its writes go to."""

    def resolved_endpoint(self) -> str | None: ...
