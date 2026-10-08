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

import logging
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from enum import Enum, auto
from typing import Literal, Protocol, TypeVar

from mirage.errors.fs import enotsup, stale_write
from mirage.errors.types import StaleWriteError
from mirage.observe.context import mark_lost
from mirage.types import FileStat, PathSpec
from mirage.utils.key_prefix import key_path

logger = logging.getLogger(__name__)

T = TypeVar("T")


class CacheInvalidator(Protocol):
    """What this module needs from a cache manager.

    ``mirage.cache.manager.CacheManager`` satisfies this structurally;
    this module never imports it, keeping the dependency one-way:
    core mutators -> cache.context <- mount (pushes a manager).
    """

    async def invalidate_after_write(self, path: PathSpec) -> None: ...

    async def invalidate_after_unlink(self, path: PathSpec) -> None: ...

    async def invalidate_subtree(self, path: PathSpec) -> None: ...

    async def invalidate_ancestors(self, path: PathSpec) -> None: ...

    async def cached_bytes(self, path: PathSpec) -> bytes | None: ...

    async def read_through(
        self, path: PathSpec, fetch: Callable[[], Awaitable[bytes]]
    ) -> bytes: ...

    async def cached_size(self, path: PathSpec) -> int | None: ...

    def listing_trusted(self, folder: str) -> bool: ...

    def probed_stat(self, path: PathSpec) -> FileStat | None: ...


_active: ContextVar[CacheInvalidator | None] = ContextVar(
    "_active_cache_manager", default=None
)


def push_cache_manager(
    manager: CacheInvalidator | None,
) -> CacheInvalidator | None:
    """Set the active cache manager for the current async context.

    The mount entry point pushes its manager before dispatching a
    command, core backend mutators report through
    :func:`invalidate_after_write` / :func:`invalidate_after_unlink`, and
    the caller restores the previous value afterwards by pushing the
    manager this call returns.

    Args:
        manager (CacheInvalidator | None): Manager to activate, or None
            to clear.

    Returns:
        CacheInvalidator | None: The previously active manager, so
        callers can restore it.
    """
    prev = _active.get()
    _active.set(manager)
    return prev


def active_cache_manager() -> CacheInvalidator | None:
    """Return the active cache manager for the current async context."""
    return _active.get()


async def invalidate_after_write(path: PathSpec) -> None:
    """Report a backend write so caches are invalidated at the mutation
    site. No-op if no cache manager is active.

    Args:
        path (PathSpec): VFS-relative path that was written.
    """
    manager = _active.get()
    if manager is not None:
        await manager.invalidate_after_write(path)


async def invalidate_after_unlink(path: PathSpec) -> None:
    """Report a backend deletion so caches are invalidated at the
    mutation site. No-op if no cache manager is active.

    Args:
        path (PathSpec): VFS-relative path that was removed.
    """
    manager = _active.get()
    if manager is not None:
        await manager.invalidate_after_unlink(path)


async def invalidate_subtree(path: PathSpec) -> None:
    """Report a backend deletion that took a whole subtree with it.

    ``invalidate_after_unlink`` evicts the path's own listing and its
    parent's, which is the whole story for a file. A recursive delete
    or a directory rename also strands every listing and every cached
    body *below* the path, and those were cached under their own keys,
    so nothing above them evicts one: ``ls`` kept printing a deleted
    directory's contents and ``cat`` kept serving a deleted file's
    bytes until the index TTL expired.

    Unlike :func:`invalidate_ancestors`, this cannot be assembled from
    ``invalidate_after_write`` calls, because the set of keys beneath
    the path is only known to the caches themselves.

    Args:
        path (PathSpec): Root of the subtree that is gone.
    """
    manager = _active.get()
    if manager is not None:
        await manager.invalidate_subtree(path)


async def invalidate_after_move(path: PathSpec, folder: bool) -> None:
    """Report one end of a backend rename.

    A renamed folder strands everything cached beneath both of its
    names, so it takes :func:`invalidate_subtree`. A renamed file has
    nothing beneath it and takes :func:`invalidate_after_unlink`, which
    spares the walk of every store. The caller passes ``folder=True``
    whenever it cannot tell, and for a destination the backend may have
    replaced a non-empty folder at.

    Args:
        path (PathSpec): one end of the rename.
        folder (bool): whether that end may hold a subtree.
    """
    if folder:
        await invalidate_subtree(path)
    else:
        await invalidate_after_unlink(path)


async def evict_after(
    op: Awaitable[T], evict: Callable[[T | None], Awaitable[None]]
) -> T:
    """Run ``op``, then ``evict``, also when ``op`` fails.

    An op that fails partway (a paginated delete, a folder copy that
    merged some children) has already changed the backend, so what it
    touched is stale either way. ``evict`` gets the op's result, or None
    when the op failed. After a failed op an eviction error is logged,
    not raised, so the caller still learns why the op failed.

    Args:
        op (Awaitable[T]): The backend change.
        evict (Callable[[T | None], Awaitable[None]]): Records and
            evicts what the op changed, given its result or None.
    """
    try:
        result = await op
    except BaseException:
        try:
            await evict(None)
        except Exception as exc:
            logger.debug("evicting after a failed op: %s", exc)
        raise
    await evict(result)
    return result


async def invalidate_ancestors(path: PathSpec) -> None:
    """Evict every ancestor directory listing of ``path``.

    A single ``invalidate_after_write`` only refreshes the immediate
    parent listing. When an op materializes several missing levels at
    once (``mkdir -p a/b/c``, a bucket write that creates parents), the
    higher ancestors' cached listings stay stale and hide the new
    entries until the index TTL expires. Walking the chain refreshes
    each one.

    Args:
        path (PathSpec): Mutated path, retaining its full virtual path.
    """
    manager = _active.get()
    if manager is not None:
        await manager.invalidate_ancestors(path)


def listing_refreshed(folder: str) -> bool:
    """Whether the active mount's listing of ``folder`` is recent enough.

    The same rule as the fresh listing gate: written during this command,
    or within the trust window when no command is running.

    Args:
        folder (str): mount-absolute directory key.
    """
    manager = active_cache_manager()
    return manager is not None and manager.listing_trusted(folder)


_read_facts: ContextVar[tuple[str, list[tuple[bytes, str | None]]] | None] = (
    ContextVar("_cache_read_facts", default=None)
)


async def capture_read(
    path: str, fetch: Callable[[], Awaitable[T]]
) -> tuple[T, list[str | None]]:
    """Collect tokens belonging to the exact bytes returned by a fetch.

    Args:
        path (str): virtual cache key.
        fetch (Callable): whole-file backend reader.
    """
    facts: list[tuple[bytes, str | None]] = []
    token = _read_facts.set((path, facts))
    try:
        data = await fetch()
        return data, [fp for body, fp in facts if body is data]
    finally:
        _read_facts.reset(token)


def publish_read(path: str, data: bytes, fingerprint: str | None) -> None:
    """Publish a backend-verified token without activating observation.

    Args:
        path (str): virtual file path.
        data (bytes): the exact object the reader returns.
        fingerprint (str | None): token proven by these bytes, or unknown.
    """
    capture = _read_facts.get()
    if capture is not None and capture[0] == path:
        capture[1].append((data, fingerprint))


@dataclass(frozen=True, slots=True)
class WriteCondition:
    """The precondition one write carries.

    Empty when mirage holds no version of the object: the write goes out
    plain, there being nothing to compare.

    Args:
        if_match (str | None): the version the object must still have.
    """

    if_match: str | None = None


@dataclass(frozen=True, slots=True)
class WriteContext:
    """What a write on a ``write: conditional`` mount needs to know.

    Pushed by the mount's own doors (``execute_op``, ``execute_cmd``), so
    a write always sees the context of the mount it lands on; an
    unconditional mount pushes None, which also clears an outer one.

    Args:
        vfs (str): the backend's name, for a refusal.
        conditions (frozenset[str]): the ops the backend can condition
            (put, copy, delete).
        read_version (Callable): the version the mount last saw for a
            path (its cached copy's token), None when it saw none.
        read_versions (Callable): ``read_version`` for many paths at
            once, in one store round trip.
        drop (Callable): drops the mount's cached copy of a path, so the
            read a refusal asks for really fetches.
        keep (Callable): keeps a version for a path without bytes, the
            one a refused write lost on.
    """

    vfs: str
    conditions: frozenset[str]
    read_version: Callable[[PathSpec], Awaitable[str | None]]
    read_versions: Callable[[list[PathSpec]], Awaitable[list[str | None]]]
    drop: Callable[[PathSpec], Awaitable[None]]
    keep: Callable[[PathSpec, str], Awaitable[None]]


WriteKind = Literal["write", "copy", "delete"]

# The version the mount saw for each of a walk's keys that it saw one for.
KnownVersions = Callable[[list[str]], Awaitable[dict[str, str]]]

_write: ContextVar[WriteContext | None] = ContextVar(
    "_write_context", default=None
)


class OwnRead(Enum):
    """An op's own read that found no file, as against one it never made."""

    ABSENT = auto()


_own_version: ContextVar[str | OwnRead | None] = ContextVar(
    "_own_write_version", default=None
)


def push_write_context(context: WriteContext | None) -> WriteContext | None:
    """Set the write context for the current async context.

    Args:
        context (WriteContext | None): the mount's context, None for an
            unconditional mount.

    Returns:
        WriteContext | None: the previous one, for the caller to restore.
    """
    prev = _write.get()
    _write.set(context)
    return prev


async def read_versioned(
    path: PathSpec, fetch: Callable[[], Awaitable[T]]
) -> tuple[T, str | None]:
    """Run a read and return its bytes with the token they carried.

    For an op that writes back what it read: the token is the one its
    backend published for these exact bytes, None when it published none
    or published two that disagree.

    Args:
        path (PathSpec): the path read.
        fetch (Callable): the read.
    """
    data, facts = await capture_read(path.virtual, fetch)
    token = facts[0] if facts and all(f == facts[0] for f in facts) else None
    return data, token


@contextmanager
def own_write_version(version: str | OwnRead | None) -> Iterator[None]:
    """Hand the version an op just read to the write it makes next.

    A read-modify-write op (an append, a pwrite through a descriptor, a
    resize) bases its write on what it read itself, not on what the
    agent read, so its write carries that read's version.

    Args:
        version (str | OwnRead | None): the token of the bytes the op
            read, or ABSENT when its read found no file.
    """
    token = _own_version.set(version)
    try:
        yield
    finally:
        _own_version.reset(token)


async def write_condition(
    path: PathSpec,
    kind: WriteKind,
    own: str | OwnRead | None = None,
    prefer_own: bool = True,
) -> WriteCondition | None:
    """The condition a write to ``path`` must carry, None when unconditional.

    The version is the op's own read's (``own``, or one handed down by
    :func:`own_write_version`) when ``prefer_own``; otherwise the mount's
    cached version first. With none, the write goes out plain.

    Args:
        path (PathSpec): the path written.
        kind (WriteKind): write, copy or delete.
        own (str | OwnRead | None): the version the op itself just saw,
            or ABSENT when its read found no file: a file the mount holds a
            version of was removed since, so the write is refused; one it
            never saw is written plain.
        prefer_own (bool): whether the op's own version wins over the
            mount's cached one (true for a read-modify-write, false for a
            delete, which falls back to its own lookup).

    Raises:
        StaleWriteError: the op found removed a file the mount saw.
        OperationNotSupportedError: the backend cannot condition this op.
    """
    context = _write.get()
    if context is None:
        return None
    own = own if own is not None else _own_version.get()
    cached = await context.read_version(path)
    if own is OwnRead.ABSENT:
        if cached:
            raise await stale(path, gone=True)
        own = None
    version = (own or cached) if prefer_own else (cached or own)
    needed = kind if kind in ("copy", "delete") else "put" if version else None
    if needed is not None and needed not in context.conditions:
        raise enotsup(context.vfs, f"conditional {kind}", path)
    return WriteCondition(if_match=version or None)


def conditioned(path: PathSpec, kind: Literal["copy", "delete"]) -> bool:
    """Whether a ``kind`` on ``path`` goes out conditioned.

    For a prefix walk, which conditions each key itself and needs no
    version for the operand.

    Args:
        path (PathSpec): the operand.
        kind (Literal["copy", "delete"]): the op.

    Raises:
        OperationNotSupportedError: the backend cannot condition this op.
    """
    context = _write.get()
    if context is None:
        return False
    if kind not in context.conditions:
        raise enotsup(context.vfs, f"conditional {kind}", path)
    return True


async def drop_cached(path: PathSpec, keep: str | None = None) -> None:
    """Drop the write context's cached copy of ``path``, if there is one.

    The line marks it lost too, so nothing it read of the path earlier is
    cached again when it ends. A refused write keeps the version it lost
    on: a retry without a read sends it again and is refused again, rather
    than going out plain over the newer file.

    Args:
        path (PathSpec): the path to drop.
        keep (str | None): the version to keep without bytes, if any.
    """
    mark_lost(path.virtual, keep)
    context = _write.get()
    if context is not None:
        await context.drop(path)
        if keep:
            await context.keep(path, keep)


async def stale(
    path: PathSpec,
    landed: bool = False,
    gone: bool = False,
    version: str | None = None,
) -> StaleWriteError:
    """The refusal for a lost condition, after dropping the cached copy.

    The version the write lost on is kept, so a retry without a read is
    refused again; a file found gone keeps none, there being no newer
    bytes for a retry to overwrite.

    Args:
        path (PathSpec): the path whose write lost.
        landed (bool): a move's copy landed before its source's delete
            lost.
        gone (bool): the file no longer exists.
        version (str | None): the version the write sent, when the line
            no longer names it (a move retracts both paths).
    """
    context = _write.get()
    keep = None
    if not gone and context is not None:
        keep = version or await context.read_version(path)
    await drop_cached(path, keep)
    err = stale_write(path)
    err.landed = landed
    return err


def known_versions(root: PathSpec, key_prefix: str) -> KnownVersions:
    """The versions a prefix walk under ``root`` measures its keys against.

    A key the agent read is held to the version it read; the walk's own
    listing only stands in for keys it never saw.

    Args:
        root (PathSpec): the walk's operand, for addressing its keys.
        key_prefix (str): the mount's backend key prefix.
    """

    async def known(keys: list[str]) -> dict[str, str]:
        context = _write.get()
        if context is None or not keys:
            return {}
        tokens = await context.read_versions(
            [key_path(root, key_prefix, key) for key in keys]
        )
        return {key: tok for key, tok in zip(keys, tokens) if tok}

    return known
