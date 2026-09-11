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
from contextlib import asynccontextmanager

from mirage.cache.file.io import mutation_lock
from mirage.cache.file.mixin import FileCacheMixin
from mirage.cache.index.store import IndexCacheStore
from mirage.cache.index.view import IndexView
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


class CacheManager:
    """Post-mutation cache coherence for one mount.

    A backend mutation has two cache consequences: the file-cache entry
    for the path is stale, and the parent directory listing in the
    index cache (including negative knowledge that the path does not
    exist) is stale. This class discharges both, synchronously, at the
    mutation site: core backend mutators report through
    ``mirage.cache.context`` right where they already emit observe
    records, so invalidation happens before the next command in a
    pipeline runs instead of after the whole command tree.
    """

    def __init__(self,
                 file_cache: FileCacheMixin | None,
                 index: IndexCacheStore,
                 prefix: str,
                 caches_reads: bool,
                 owns_path: Callable[[str], bool] = lambda _: True) -> None:
        """Args:
            file_cache (FileCacheMixin | None): Workspace file cache
                store; entries are keyed by mount-absolute path.
            index (IndexCacheStore): The mount resource's index cache;
                listings are keyed by mount-absolute path, which every
                backend agrees on.
            prefix (str): Mount prefix (e.g. "/data/").
            caches_reads (bool): Whether the resource caches reads; the
                file cache only holds paths for read-caching backends.
            owns_path: whether this mount still owns a virtual cache key.
        """
        self._file_cache = file_cache
        self._index = index
        self._prefix = prefix.rstrip("/")
        self._caches_reads = caches_reads
        self._owns_path = owns_path

    @asynccontextmanager
    async def mutation(self) -> AsyncIterator[None]:
        """Drain raw backend index access before mount cache eviction."""
        if self._file_cache is None:
            yield
            return
        async with mutation_lock(self._file_cache):
            yield

    async def clear_index(self, index: IndexCacheStore) -> None:
        """Clear the whole backend index while this mount still owns it."""
        async with self.mutation():
            if self._owns_path(self._prefix or "/"):
                await index.clear()

    def scope_index(self, index: IndexCacheStore) -> IndexCacheStore:
        """Bind backend metadata writes to this mount's lifetime."""
        if self._file_cache is None or isinstance(index, IndexView):
            return index
        return IndexView(index, self._file_cache, self._prefix,
                         self._owns_path)

    async def _evict_dir(self, key: str) -> None:
        """Drop one directory's cached listing.

        Both spellings of the directory go, because a backend may have
        keyed it with or without its trailing slash and an eviction that
        hits no key is silent.

        Args:
            key (str): Cache key of the directory (mount-absolute).
        """
        await self._index.invalidate_dir(key)
        await self._index.invalidate_dir(key + "/")

    def _cache_key(self, path: PathSpec) -> str:
        """Cache key for a path, derived rather than inferred.

        Both caches this class evicts from are keyed by the
        mount-absolute virtual path, so that is what this returns: the
        mount prefix still attached, not the mount-relative spelling
        ``mount_key`` produces on the way there.

        Only ``virtual`` is read, and the key is rebuilt against this
        manager's own prefix, exactly as ``Mount.execute_op`` rebuilds
        one before handing a path to a backend. The caller's
        ``resource_path`` is deliberately ignored: it is not a fact
        this class can trust, because ``PathSpec.from_str_path``
        fabricates one ("assumed root-mounted") for any caller that
        does not know its mount, and ~50 sites take that default.

        The earlier version inferred which convention had arrived by
        comparing the two strings, which cannot be done: under a ``/d``
        mount a mount-relative ``/d`` and an absolute ``/d`` are the
        same characters naming different files. Inferring wrong is
        quiet rather than loud -- a key one level off simply evicts
        nothing -- which is why it survived. Deriving asks no question
        that has no answer.

        Args:
            path (PathSpec): Path to key; only ``virtual`` is read.
        """
        key = mount_key(path.virtual, self._prefix)
        return f"{self._prefix}/{key}" if key else self._prefix or "/"

    async def cached_bytes(self, path: PathSpec) -> bytes | None:
        """Return cached bytes for ``path`` if present, else None.

        Lookup only: never fetches from the backend. The single
        read-cache check, called by the shared read-through wrappers
        (``mirage.cache.read_through``) that every read command reads
        through, so warm reads are served from the file cache without the
        command knowing about it.

        Args:
            path (PathSpec): the path to look up.
        """
        key = self._cache_key(path)
        if (not self._caches_reads or self._file_cache is None
                or not self._owns_path(key)):
            return None
        if await self._file_cache.exists(key):
            cached = await self._file_cache.get(key)
            return cached if self._owns_path(key) else None
        return None

    async def invalidate_after_write(self, path: PathSpec) -> None:
        """Invalidate caches after a write to ``path``.

        Args:
            path (PathSpec): Path that was written; only ``virtual`` is
                read.
        """
        key = self._cache_key(path)
        if self._caches_reads and self._file_cache is not None:
            await self._file_cache.remove(key)
        await self._invalidate_parent(key)

    async def invalidate_after_unlink(self, path: PathSpec) -> None:
        """Invalidate caches after a deletion of ``path``.

        Args:
            path (PathSpec): Path that was removed; only ``virtual`` is
                read.
        """
        key = self._cache_key(path)
        if self._caches_reads and self._file_cache is not None:
            await self._file_cache.remove(key)
        await self._evict_dir(key)
        await self._invalidate_parent(key)

    async def invalidate_subtree(self, path: PathSpec) -> None:
        """Drop ``path`` and everything cached beneath it.

        Two callers, one shape. A push notification often says only
        which folder moved, and a recursive delete or a directory
        rename takes a whole tree with it; either way the listings and
        bodies below the path were cached independently, so evicting
        the path and its parent leaves stale entries one level down.
        The cheaper ``invalidate_after_write`` cannot be widened to do
        this, because it also runs on every ordinary write, where a
        file has no subtree to drop.

        Args:
            path (PathSpec): Root of the stale subtree; only ``virtual``
                is read.
        """
        key = self._cache_key(path)
        if self._caches_reads and self._file_cache is not None:
            await self._file_cache.remove(key)
            await self._file_cache.evict_prefix(key.rstrip("/") + "/")
        await self._index.invalidate_prefix(key)
        await self._evict_dir(key)
        await self._invalidate_parent(key)

    async def invalidate_ancestors(self, path: PathSpec) -> None:
        """Evict the listing of every directory above ``path``'s parent.

        ``invalidate_after_write`` refreshes the immediate parent only. A
        keyed store materializes every missing level of a key in a single
        put, so the listings further up gained entries too and would keep
        serving the pre-write view until the index TTL expires. A backend
        with real directories cannot gain a level that way, so there this
        is a handful of spare evictions.

        Args:
            path (PathSpec): Path that was mutated; only ``virtual`` is
                read.
        """
        parent = self._cache_key(path).rsplit("/", 1)[0]
        while parent and parent != self._prefix:
            parent = parent.rsplit("/", 1)[0]
            await self._evict_dir(parent or "/")

    async def drop_prefix(self) -> None:
        """Drop every cached body under this mount, path unspecified.

        For a mutation that names no path: an account CLI writes to its
        service by id, so nothing here can say which file changed, only
        that this mount's bytes may no longer match the service. Clearing
        the listing alone is not enough, because an already-read body is
        served warm and would keep answering with the pre-write content.

        Over-evicts when this mount is the root and another mount sits
        beneath it, since keys are compared by prefix. That costs a
        refetch, which is the safe direction to be wrong in.
        """
        if not self._caches_reads or self._file_cache is None:
            return
        await self._file_cache.evict_prefix(self._prefix + "/")

    async def _invalidate_parent(self, key: str) -> None:
        await self._evict_dir(key.rsplit("/", 1)[0] or "/")
