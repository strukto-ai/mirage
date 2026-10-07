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

from collections.abc import AsyncIterator, Callable
from functools import partial
from typing import Any

from mirage.accessor.base import Accessor
from mirage.cache.context import CacheInvalidator, active_cache_manager
from mirage.types import (
    PathSpec,
    ReadBytesFn,
    ReadStreamFn,
)


async def _serve_stream(
    manager: CacheInvalidator | None,
    start: Callable[[], AsyncIterator[bytes]],
    path: PathSpec,
) -> AsyncIterator[bytes]:
    # `start` defers the backend call so a warm hit never opens a stream.
    if manager is not None:
        cached = await manager.cached_bytes(path)
        if cached is not None:
            yield cached
            return
    source = start()
    try:
        async for chunk in source:
            yield chunk
    finally:
        close = getattr(source, "aclose", None)
        if close is not None:
            await close()


def cache_aware_read_stream(raw: ReadStreamFn) -> ReadStreamFn:
    """Wrap a backend ``read_stream`` so warm reads serve cached bytes.

    The returned reader keeps the backend's ``(accessor, path, ...)``
    signature, so it is a drop-in for the raw op on ``CommandIO`` (the
    factory wraps it there per invocation). On a warm hit it yields
    the whole cached blob as one chunk; otherwise it streams from the
    backend. ``cached_bytes`` is a no-op (returns None) for local or
    non-caching mounts, so this is safe to apply uniformly.

    Capture the active cache manager when binding the reader, falling
    back to its invocation scope when bound outside a command. Lazy
    consumers keep that manager after the command scope has returned.

    Args:
        raw (ReadStreamFn): the backend ``read_stream`` op.
    """

    bound = active_cache_manager()

    def reader(
        accessor: Accessor | None, path: PathSpec, *args: Any, **kwargs: Any
    ) -> AsyncIterator[bytes]:
        manager = bound or active_cache_manager()
        return _serve_stream(
            manager, partial(raw, accessor, path, *args, **kwargs), path
        )

    return reader


def cache_aware_read_bytes(raw: ReadBytesFn) -> ReadBytesFn:
    """Cache complete backend renders and reuse them across read commands.

    Drop-in for the raw ``(accessor, path, ...)`` op, same signature (the
    factory wraps ``CommandIO`` ops with it). Returns the cached bytes on
    a warm hit, else fills the cache from the full backend render. No-op
    for local or non-caching mounts.

    Args:
        raw (ReadBytesFn): the backend ``read_bytes`` op.
    """

    bound = active_cache_manager()

    async def reader(
        accessor: Accessor | None, path: PathSpec, *args: Any, **kwargs: Any
    ) -> bytes:
        manager = bound or active_cache_manager()
        if manager is not None:
            return await manager.read_through(
                path, partial(raw, accessor, path, *args, **kwargs)
            )
        return await raw(accessor, path, *args, **kwargs)

    return reader
