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
from typing import Literal, Protocol, TypeVar

from mirage.cache.types import (
    KnownVersions,
    LiveVersion,
    OwnRead,
    WriteCondition,
    WriteContext,
    WriteKind,
)
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


_write: ContextVar[WriteContext | None] = ContextVar(
    "_write_context", default=None
)


_own_version: ContextVar[tuple[str, str | OwnRead | None] | None] = ContextVar(
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
def own_write_version(
    path: PathSpec, version: str | OwnRead | None
) -> Iterator[None]:
    """Hand the version an op just read to its write of the same path.

    A read-modify-write op (an append, a pwrite through a descriptor, a
    resize) bases its write on what it read itself, not on what the
    agent read, so its write carries that read's version.

    Args:
        path (PathSpec): the path the op read and writes.
        version (str | OwnRead | None): the token of the bytes the op
            read, or ABSENT when its read found no file.
    """
    token = _own_version.set((path.virtual, version))
    try:
        yield
    finally:
        _own_version.reset(token)


async def write_condition(
    path: PathSpec, kind: WriteKind
) -> WriteCondition | None:
    """The condition a write to ``path`` must carry, None when unconditional.

    The version is the op's own read's, handed down by
    :func:`own_write_version`, else the mount's cached one. With none, the
    write goes out plain. An op's own read that found no file refuses a
    write to a file the mount holds a version of: it was removed since.

    Args:
        path (PathSpec): the path written.
        kind (WriteKind): put, copy or delete.

    Raises:
        StaleWriteError: the op found removed a file the mount saw.
        OperationNotSupportedError: the backend cannot condition this op.
    """
    context = _write.get()
    if context is None:
        return None
    cached = await context.read_version(path)
    return await _settle(context, path, kind, _own_version_for(path), cached)


async def delete_condition(
    path: PathSpec, looked_up: str | None
) -> WriteCondition | None:
    """The condition a delete of ``path`` carries, None when unconditional.

    A delete needs no read of its own, only that nobody wrote since: the
    version the mount holds, else the one its own lookup found.

    Args:
        path (PathSpec): the path deleted.
        looked_up (str | None): the version the delete's lookup found.

    Raises:
        OperationNotSupportedError: the backend cannot condition a delete.
    """
    context = _write.get()
    if context is None:
        return None
    cached = await context.read_version(path)
    return _condition(context, path, "delete", cached or looked_up)


async def move_condition(
    src: PathSpec, dst: PathSpec
) -> tuple[WriteCondition | None, str | None]:
    """The conditions a move carries: the copy onto ``dst``, the source pin.

    Both versions come from one store lookup.

    Args:
        src (PathSpec): the source, whose delete is pinned.
        dst (PathSpec): the destination, whose copy is conditioned.

    Returns:
        tuple[WriteCondition | None, str | None]: the copy's condition,
        None when unconditional, and the source's version, None without
        one.

    Raises:
        StaleWriteError: the op found removed a file the mount saw.
        OperationNotSupportedError: the backend cannot condition the move.
    """
    context = _write.get()
    if context is None:
        return None, None
    dst_cached, src_cached = await context.read_versions([dst, src])
    cond = await _settle(
        context, dst, "copy", _own_version_for(dst), dst_cached
    )
    source = await _settle(
        context, src, "delete", _own_version_for(src), src_cached
    )
    return cond, source.if_match


def _own_version_for(path: PathSpec) -> str | OwnRead | None:
    held = _own_version.get()
    return held[1] if held is not None and held[0] == path.virtual else None


async def _settle(
    context: WriteContext,
    path: PathSpec,
    kind: WriteKind,
    own: str | OwnRead | None,
    cached: str | None,
) -> WriteCondition:
    if own is OwnRead.ABSENT:
        if cached:
            raise await stale(path, gone=True)
        own = None
    return _condition(context, path, kind, own or cached)


def _condition(
    context: WriteContext, path: PathSpec, kind: WriteKind, version: str | None
) -> WriteCondition:
    # A put with no version goes out plain, so it needs no condition.
    if kind != "put" or version:
        _require(context, path, kind)
    return WriteCondition(if_match=version or None)


def _require(context: WriteContext, path: PathSpec, kind: WriteKind) -> None:
    if kind not in context.conditions:
        raise enotsup(context.vfs, f"conditional {kind}", path)


async def native_condition(
    path: PathSpec,
    cond: WriteCondition | None,
    live: LiveVersion | None,
    kind: WriteKind,
) -> str | None:
    """The backend's own token a conditioned write sends, None to go plain.

    The held version is a content token, so it is compared with the live
    one here and the live native token goes out in its place: the backend
    refuses whatever lands between this lookup and the write.

    Args:
        path (PathSpec): the path written.
        cond (WriteCondition | None): the condition the write carries.
        live (LiveVersion | None): the file's current tokens, None when
            the backend has no file there.
        kind (WriteKind): the op the token conditions, for the refusal.

    Raises:
        StaleWriteError: the file changed or went since it was read.
        OperationNotSupportedError: the backend gave no token to send.
    """
    held = cond.if_match if cond is not None else None
    if not held:
        return None
    if live is None:
        raise await stale(path, gone=True)
    if live.content != held:
        raise await stale(path, version=held)
    if not live.native:
        context = _write.get()
        assert context is not None
        raise enotsup(context.vfs, f"conditional {kind}", path)
    return live.native


def writes_conditioned() -> bool:
    """Whether the mount running this op is a ``write: conditional`` one.

    A backend asks before handing a read's token on to the op's write, so
    an unconditional mount's reads cache exactly what they did.

    Returns:
        bool: True on a ``write: conditional`` mount.
    """
    return _write.get() is not None


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
    _require(context, path, kind)
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
    mark_lost(path, keep)
    context = _write.get()
    if context is not None:
        await context.drop(path)
        if keep:
            await context.keep(path, keep)


async def evict_keeping_version(path: PathSpec) -> None:
    """Evict ``path``'s cached bytes and listing, keeping the version held.

    For a request that raised and may or may not have changed the path:
    what is cached may now be stale, but the version mirage holds keeps
    the next write conditioned, so a change the request did make is
    refused rather than written over. Without a write context it is a
    plain eviction.

    Args:
        path (PathSpec): the path the request may have changed.
    """
    context = _write.get()
    if context is None:
        await invalidate_after_write(path)
        return
    version = await context.read_version(path)
    await context.drop(path)
    if version:
        await context.keep(path, version)


async def stale(
    path: PathSpec,
    landed: bool = False,
    gone: bool = False,
    version: str | OwnRead | None = None,
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
        version (str | OwnRead | None): the version the write sent, when
            the line no longer names it (a move retracts both paths);
            ABSENT when the op found the file gone, which keeps none.
    """
    context = _write.get()
    keep = None
    if not gone and version is not OwnRead.ABSENT and context is not None:
        keep = version or await context.read_version(path)
    await drop_cached(path, keep)
    return stale_write(path, landed=landed)


async def keep_refused(
    lost: list[tuple[PathSpec, str | None]],
) -> StaleWriteError | None:
    """Keep the version of every file a walk left behind, and refuse the first.

    Each file the walk found changed keeps the version it lost on, so a
    retry without a read is refused on any of them, not only the one
    named; this holds when the walk stopped on a later error too.

    Args:
        lost (list[tuple[PathSpec, str | None]]): each file left behind,
            with the version it lost on.

    Returns:
        StaleWriteError | None: the refusal naming the first, or None.
    """
    refusals = [await stale(spec, version=version) for spec, version in lost]
    return refusals[0] if refusals else None


async def held_versions(paths: list[PathSpec]) -> list[str | None]:
    """The version the mount holds for each path, in one store round trip.

    For a walk that measures its files against what the agent read; every
    None on an unconditional mount.

    Args:
        paths (list[PathSpec]): the paths, in order.
    """
    context = _write.get()
    if context is None or not paths:
        return [None] * len(paths)
    return await context.read_versions(paths)


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
