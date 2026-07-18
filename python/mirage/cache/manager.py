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

from mirage.cache.file.mixin import FileCacheMixin
from mirage.cache.index.store import IndexCacheStore
from mirage.types import PathSpec


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

    def __init__(self, file_cache: FileCacheMixin | None,
                 index: IndexCacheStore | None, prefix: str,
                 caches_reads: bool) -> None:
        """Args:
            file_cache (FileCacheMixin | None): Workspace file cache
                store; entries are keyed by mount-absolute path.
            index (IndexCacheStore | None): The mount resource's index
                cache; listings are keyed by mount-absolute path.
            prefix (str): Mount prefix (e.g. "/data/").
            caches_reads (bool): Whether the resource caches reads; the
                file cache only holds paths for read-caching backends.
        """
        self._file_cache = file_cache
        self._index = index
        self._prefix = prefix.rstrip("/")
        self._caches_reads = caches_reads

    def _virtual(self, path: PathSpec) -> str:
        mount_path = path.mount_path
        if not mount_path.startswith("/"):
            mount_path = "/" + mount_path
        if self._prefix and not mount_path.startswith(self._prefix):
            return self._prefix + mount_path
        return mount_path

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
        if not self._caches_reads or self._file_cache is None:
            return None
        virtual = self._virtual(path)
        if await self._file_cache.exists(virtual):
            return await self._file_cache.get(virtual)
        return None

    async def invalidate_after_write(self, path: PathSpec) -> None:
        """Invalidate caches after a write to ``path``.

        Args:
            path (PathSpec): Resource-relative path that was written.
        """
        virtual = self._virtual(path)
        if self._caches_reads and self._file_cache is not None:
            await self._file_cache.remove(virtual)
        await self._invalidate_parent(virtual)

    async def invalidate_after_unlink(self, path: PathSpec) -> None:
        """Invalidate caches after a deletion of ``path``.

        Args:
            path (PathSpec): Resource-relative path that was removed.
        """
        virtual = self._virtual(path)
        if self._caches_reads and self._file_cache is not None:
            await self._file_cache.remove(virtual)
        if self._index is not None:
            await self._index.invalidate_dir(virtual)
            await self._index.invalidate_dir(virtual + "/")
        await self._invalidate_parent(virtual)

    async def _invalidate_parent(self, virtual: str) -> None:
        if self._index is None:
            return
        parent = virtual.rsplit("/", 1)[0] or "/"
        await self._index.invalidate_dir(parent)
        await self._index.invalidate_dir(parent + "/")
