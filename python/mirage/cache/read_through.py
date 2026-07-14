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

import inspect
from collections.abc import AsyncIterator, Callable

from mirage.cache.context import active_cache_manager
from mirage.types import PathSpec


async def _serve_stream(manager, raw: Callable, accessor, path: PathSpec,
                        *args, **kwargs) -> AsyncIterator[bytes]:
    if manager is not None and isinstance(path, PathSpec):
        cached = await manager.cached_bytes(path)
        if cached is not None:
            yield cached
            return
    source = raw(accessor, path, *args, **kwargs)
    try:
        async for chunk in source:
            yield chunk
    finally:
        close = getattr(source, "aclose", None)
        if close is not None:
            await close()


def cache_aware_read_stream(raw: Callable) -> Callable:
    """Wrap a backend ``read_stream`` so warm reads serve cached bytes.

    The returned reader keeps the backend's ``(accessor, path, ...)``
    signature, so it is a drop-in for the raw reader wherever a command
    injects one (the factory, ``head_multi``, ``generic_grep``, ...). On a
    warm hit it yields the whole cached blob as one chunk; otherwise it
    streams from the backend. ``cached_bytes`` is a no-op (returns None)
    for local or non-caching mounts, so this is safe to apply uniformly.

    The wrapper is a ``def`` (not an ``async def``) that captures the
    active cache manager eagerly and returns the async generator: the
    manager must be read when the command calls the reader (inside the
    mount's cache-manager scope), not lazily when the stream drains, by
    which time that scope is gone.

    Args:
        raw (Callable): the backend ``read_stream`` op.
    """

    def reader(accessor, path: PathSpec, *args, **kwargs):
        manager = active_cache_manager()
        return _serve_stream(manager, raw, accessor, path, *args, **kwargs)

    return reader


def cache_aware_read_bytes(raw: Callable) -> Callable:
    """Wrap a backend ``read_bytes`` so warm reads serve cached bytes.

    Drop-in for the raw reader, same signature. Returns the cached bytes
    on a warm hit, else reads from the backend. No-op for local or
    non-caching mounts.

    Args:
        raw (Callable): the backend ``read_bytes`` op.
    """

    async def reader(accessor, path: PathSpec, *args, **kwargs) -> bytes:
        manager = active_cache_manager()
        if manager is not None and isinstance(path, PathSpec):
            cached = await manager.cached_bytes(path)
            if cached is not None:
                return cached
        return await raw(accessor, path, *args, **kwargs)

    return reader


def cache_aware_read(raw: Callable) -> Callable:
    """Wrap a polymorphic reader so warm reads serve cached bytes.

    For the ``read`` contract used by ``head_multi`` / ``tail_multi`` /
    wc ``format_multi``: the reader is called as ``read(accessor, path,
    ...)`` and may return bytes, an awaitable of bytes, or an async byte
    iterator. On a warm hit the wrapped reader returns the cached bytes;
    otherwise it calls the raw reader and returns whatever it produced
    unchanged, so the consumer's own ``isawaitable`` / ``ensure_stream``
    normalization still applies. No-op for local or non-caching mounts.

    The active cache manager is captured **eagerly**, when this wrapper
    is applied, not when the wrapped reader is later called: a consumer
    that yields lazily (``head_multi``) is drained after the mount's
    cache-manager scope is gone, so reading the contextvar at drain time
    would always miss. Apply this wrapper inside the command's scope
    (which the consumers do) so the captured manager travels with the
    stream, mirroring :func:`cache_aware_read_stream`.

    Args:
        raw (Callable): the backend reader (bytes / awaitable / stream).
    """
    manager = active_cache_manager()

    async def reader(accessor, path: PathSpec, *args, **kwargs):
        if manager is not None and isinstance(path, PathSpec):
            cached = await manager.cached_bytes(path)
            if cached is not None:
                return cached
        result = raw(accessor, path, *args, **kwargs)
        if inspect.isawaitable(result):
            return await result
        return result

    return reader


async def cached_prefix_bytes(path: PathSpec, n: int | None) -> bytes | None:
    """Return the first ``n`` cached bytes of ``path`` when warm, else None.

    Lets a range-read fast path (e.g. ``head -c N``) serve from a fully
    cached file without a partial backend fetch. ``n=None`` returns the
    whole cached blob.

    Args:
        path (PathSpec): the path to look up.
        n (int | None): byte count, or None for the whole file.
    """
    manager = active_cache_manager()
    if manager is None or not isinstance(path, PathSpec):
        return None
    cached = await manager.cached_bytes(path)
    if cached is None:
        return None
    return cached if n is None else cached[:n]
