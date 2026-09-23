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

from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from typing import Generic, Literal, Protocol, TypeVar

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.types import FileStat, PathSpec

A = TypeVar("A", bound=Accessor)
C = TypeVar("C")
A_contra = TypeVar("A_contra", bound=Accessor, contravariant=True)


class ReaddirFn(Protocol[A_contra]):

    def __call__(self,
                 accessor: A_contra,
                 path_spec: PathSpec,
                 index: IndexCacheStore = ...) -> Awaitable[list[str]]:
        ...


class StatFn(Protocol[A_contra]):

    def __call__(self,
                 accessor: A_contra,
                 path_spec: PathSpec,
                 index: IndexCacheStore = ...) -> Awaitable[FileStat]:
        ...


class ExistsFn(Protocol[A_contra]):

    def __call__(self, accessor: A_contra, path: PathSpec) -> Awaitable[bool]:
        ...


class PathFn(Protocol[A_contra]):

    def __call__(self, accessor: A_contra,
                 path_spec: PathSpec) -> Awaitable[None]:
        ...


class RmdirFn(Protocol[A_contra]):
    """``PathFn`` plus the rmdir slot's optional ``index``, which rides
    the call for the command tier's hidden-remnant listing; the store
    itself never consults it."""

    def __call__(self,
                 accessor: A_contra,
                 path_spec: PathSpec,
                 index: IndexCacheStore = ...) -> Awaitable[None]:
        ...


class PairFn(Protocol[A_contra]):

    def __call__(self, accessor: A_contra, src_spec: PathSpec,
                 dst_spec: PathSpec) -> Awaitable[None]:
        ...


class WriteFn(Protocol[A_contra]):

    def __call__(self, accessor: A_contra, path_spec: PathSpec,
                 data: bytes) -> Awaitable[None]:
        ...


class MkdirFn(Protocol[A_contra]):

    def __call__(self,
                 accessor: A_contra,
                 path_spec: PathSpec,
                 parents: bool = ...) -> Awaitable[None]:
        ...


class TruncateFn(Protocol[A_contra]):

    def __call__(self, accessor: A_contra, path_spec: PathSpec,
                 length: int) -> Awaitable[None]:
        ...


class DuEntriesFn(Protocol[A_contra]):

    def __call__(
        self,
        accessor: A_contra,
        path_spec: PathSpec,
        index: IndexCacheStore = ...
    ) -> Awaitable[tuple[list[tuple[str, int]], int]]:
        ...


class DuSizeFn(Protocol[A_contra]):

    def __call__(self,
                 accessor: A_contra,
                 path_spec: PathSpec,
                 index: IndexCacheStore = ...) -> Awaitable[int]:
        ...


@dataclass(frozen=True, slots=True)
class ChildEntry:
    """One entry a driver saw while listing the immediate children of a
    prefix.

    ``marker`` entries carry no name of their own (the zero-byte marker
    keyed at the listed prefix itself, or a key the delimiter listing
    cannot classify); they still prove the prefix holds a key, which is
    what separates an empty directory from a missing one.

    Args:
        key (str): raw backend key, no trailing slash for files and
            directories.
        kind (Literal["f", "d", "marker"]): file, directory, or a key
            that only proves existence.
        size (int | None): file byte size; None when the store did not
            report one.
        modified (str): ISO-8601 mtime; empty when unknown.
    """
    key: str
    kind: Literal["f", "d", "marker"]
    size: int | None = None
    modified: str = ""


@dataclass(frozen=True, slots=True)
class TreeEntry:
    """One key of a recursive listing, directory markers included.

    Args:
        key (str): raw backend key; a directory marker keeps its
            trailing slash.
        size (int | None): byte size; None when unknown, markers report 0.
        modified (str): ISO-8601 mtime, empty when unknown.
    """
    key: str
    size: int | None = 0
    modified: str = ""


@dataclass(frozen=True, slots=True)
class ObjectMeta:
    """What a point lookup of one key returned.

    Args:
        size (int): byte size of the object.
        modified (str | None): ISO-8601 mtime, when the store has one.
        fingerprint (str | None): content identity (ETag, revision id).
        revision (str | None): addressable revision id, when the store
            versions objects.
        extra (dict[str, str]): backend-shaped stat extras, forwarded
            into ``FileStat.extra`` verbatim.
    """
    size: int
    modified: str | None = None
    fingerprint: str | None = None
    revision: str | None = None
    extra: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class FindHints:
    """The find predicates a driver may push into its native query.

    Every pushed condition must select a superset of the GNU semantics;
    the shared client-side ``keep()`` pass stays authoritative.

    Args:
        name (str | None): -name glob.
        iname (str | None): -iname glob.
        type (str | None): "f" or "d".
        min_size (int | None): inclusive lower size bound.
        max_size (int | None): inclusive upper size bound.
        pushdown (bool): False when a complex predicate tree is present;
            only the prefix condition may be used then.
    """
    name: str | None
    iname: str | None
    type: str | None
    min_size: int | None
    max_size: int | None
    pushdown: bool


@dataclass(frozen=True, slots=True)
class ObjectStoreDriver(Generic[A, C]):
    """The native surface of one keyed byte store.

    Everything above this line — readdir with its index write-back,
    stat's probe ladder, find's implicit-directory synthesis, du, and
    the mutation family with its cache invalidation — derives from
    these primitives in ``mirage.core.object_store``; a backend supplies
    only the raw store calls.

    Directory semantics the primitives must honor: a directory is a key
    prefix, an empty directory is a zero-byte marker object keyed at the
    prefix itself (``key/``) on stores that accept one
    (``markers_supported``), and symlinks or hardlinks do not exist —
    ops that would need them stay unwired, which the dispatcher already
    surfaces as ENOTSUP.

    Args:
        vfs (str): VFS name, used in op records and log lines.
        scope_error (int): listing size above which readdir logs a
            warning.
        key_prefix_of (Callable): mount key prefix from the accessor's
            config ("" when the mount covers the whole store).
        connect (Callable): per-op connection context; a store holding a
            live client on its accessor yields the accessor itself.
        list_children (Callable): one-level listing of a prefix as
            :class:`ChildEntry` items; may repeat directories, the kit
            deduplicates.
        list_tree (Callable): recursive listing of every key under a
            prefix, markers included.
        list_subtree (Callable): the key at ``stem`` itself plus every
            key under ``stem + "/"`` — du's walk, which unlike
            ``list_tree`` must not match sibling keys sharing the stem
            as a name prefix.
        head (Callable): point lookup of one key, None when absent;
            classification failures propagate.
        get (Callable): full object bytes, None when absent.
        put (Callable): write one object, returning what the store's
            write response said about it, or None when the store's
            write API reports nothing at all (opendal). The meta is
            partial: ``size`` is the bytes written and ``fingerprint``
            is the store's token, spelled exactly as ``head`` spells
            it so the two can be compared; ``modified`` is absent,
            because no store's write response carries one. A store
            that answers without a token gives a meta whose
            ``fingerprint`` is None; callers read only that field, so
            they cannot tell it from None and do not need to.
            A store error meaning the container is absent
            (``is_not_found``) propagates, and the write factory
            restates it as ENOENT on the path.
        delete_file (Callable): delete one key (every revision on a
            versioned store); silent on a missing key.
        delete_prefix (Callable): delete every key under a prefix.
        probe_prefix (Callable): whether any key sits under a prefix.
        is_not_found (Callable): whether a store error means the key is
            absent.
        move_file (Callable | None): relocate one object; False when the
            source names no object. None when the store has no native
            move — rename stays unwired then, which the dispatcher
            surfaces as ENOTSUP.
        move_prefix (Callable | None): relocate every key under a
            prefix; False when the source prefix holds nothing. None
            follows ``move_file``.
        copy_file (Callable | None): copy one object; False when the
            source names no object, if the store can tell cheaply. None
            when the store has no native copy — copy stays unwired then.
        markers_supported (bool): whether the store accepts the
            zero-byte ``key/`` marker object. False when the store
            refuses one client-side (hf): an empty directory cannot
            exist there, ``make_mkdir`` has nothing to write, and a
            directory exists exactly while it holds a key.
        find_tree (Callable | None): find's listing with native
            predicate push-down, returning the iterator and whether the
            query was narrowed beyond the prefix; None means find walks
            ``list_tree`` unnarrowed.
    """
    vfs: str
    scope_error: int
    key_prefix_of: Callable[[A], str]
    connect: Callable[[A], AbstractAsyncContextManager[C]]
    list_children: Callable[[C, str], AsyncIterator[ChildEntry]]
    list_tree: Callable[[C, str], AsyncIterator[TreeEntry]]
    list_subtree: Callable[[C, str], AsyncIterator[TreeEntry]]
    head: Callable[[C, str], Awaitable[ObjectMeta | None]]
    get: Callable[[C, str], Awaitable[bytes | None]]
    put: Callable[[C, str, bytes], Awaitable[ObjectMeta | None]]
    delete_file: Callable[[C, str], Awaitable[None]]
    delete_prefix: Callable[[C, str], Awaitable[None]]
    probe_prefix: Callable[[C, str], Awaitable[bool]]
    is_not_found: Callable[[Exception], bool]
    move_file: Callable[[C, str, str], Awaitable[bool]] | None = None
    move_prefix: Callable[[C, str, str], Awaitable[bool]] | None = None
    copy_file: Callable[[C, str, str], Awaitable[bool]] | None = None
    markers_supported: bool = True
    find_tree: Callable[[C, str, FindHints], tuple[AsyncIterator[TreeEntry],
                                                   bool]] | None = None
