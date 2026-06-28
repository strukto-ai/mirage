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

from contextvars import ContextVar
from typing import Protocol

from mirage.types import PathSpec


class CacheInvalidator(Protocol):
    """What this module needs from a cache manager.

    ``mirage.cache.manager.CacheManager`` satisfies this structurally;
    this module never imports it, keeping the dependency one-way:
    core mutators -> cache.context <- mount (pushes a manager).
    """

    async def invalidate_after_write(self, path: str | PathSpec) -> None:
        ...

    async def invalidate_after_unlink(self, path: str | PathSpec) -> None:
        ...

    async def cached_bytes(self, path: PathSpec) -> bytes | None:
        ...


_active: ContextVar[CacheInvalidator | None] = ContextVar(
    "_active_cache_manager", default=None)


def push_cache_manager(
        manager: CacheInvalidator | None) -> CacheInvalidator | None:
    """Set the active cache manager for the current async context.

    Mirrors ``observe.context.push_mount_prefix``: the mount entry point
    pushes its manager before dispatching a command, core backend
    mutators report through :func:`invalidate_after_write` /
    :func:`invalidate_after_unlink`, and the caller restores the
    previous value afterwards.

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


async def invalidate_after_write(path: str | PathSpec) -> None:
    """Report a backend write so caches are invalidated at the mutation
    site. No-op if no cache manager is active.

    Args:
        path (str | PathSpec): Resource-relative path that was written.
    """
    manager = _active.get()
    if manager is not None:
        await manager.invalidate_after_write(path)


async def invalidate_after_unlink(path: str | PathSpec) -> None:
    """Report a backend deletion so caches are invalidated at the
    mutation site. No-op if no cache manager is active.

    Args:
        path (str | PathSpec): Resource-relative path that was removed.
    """
    manager = _active.get()
    if manager is not None:
        await manager.invalidate_after_unlink(path)
