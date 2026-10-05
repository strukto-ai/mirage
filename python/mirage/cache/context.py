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
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from typing import Protocol, TypeVar

from mirage.types import FileStat, PathSpec

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
