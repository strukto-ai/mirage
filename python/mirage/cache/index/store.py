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

from datetime import datetime

from mirage.cache.index.config import IndexEntry, ListResult, LookupResult


class IndexCacheStore:
    """Per-VFS metadata index for remote mounts.

    Abstract base. Maps VFS paths to IndexEntry metadata.
    Subclasses implement storage and concurrency.
    """

    def __init__(self) -> None:
        super().__init__()
        self._closed = False

    async def get(self, vfs_path: str) -> LookupResult:
        raise NotImplementedError

    def seed(self, entries: dict[str, IndexEntry],
             children: dict[str, list[str]], expires_at: datetime) -> None:
        """Merge a snapshot; flush deferred writes before operations or close.

        Repeated seeds merge by path. Clear discards queued snapshots.
        """
        raise NotImplementedError

    async def put(self, vfs_path: str, entry: IndexEntry) -> None:
        raise NotImplementedError

    async def list_dir(self, vfs_path: str) -> ListResult:
        raise NotImplementedError

    async def set_dir(
        self,
        vfs_path: str,
        entries: list[tuple[str, IndexEntry]],
        expired_at: datetime | None = None,
    ) -> None:
        raise NotImplementedError

    async def entries(self) -> dict[str, IndexEntry]:
        raise NotImplementedError

    async def invalidate_dir(self, vfs_path: str) -> None:
        raise NotImplementedError

    async def invalidate_prefix(self, vfs_path: str) -> None:
        """Drop ``vfs_path`` and everything cached below it.

        ``invalidate_dir`` drops one directory's listing and its direct
        children's entries, which is enough for a mutation that named a
        path. A push notification that can only name a scope needs the
        whole subtree gone, because the listings further down were
        cached independently and nothing above them expires them.

        Args:
            vfs_path (str): Mount-absolute root of the subtree.
        """
        raise NotImplementedError

    async def invalidate(self) -> None:
        """Mark every entry stale without discarding it.

        The difference from ``clear`` is what a later lookup can tell.
        ``clear`` leaves an empty store, which reads exactly like a store
        that was never filled, so a backend whose index *is* its listing
        cannot tell an invalidation from an empty repository. Expiring
        instead keeps that distinction: the lookup answers EXPIRED and
        the backend knows to refetch.
        """
        raise NotImplementedError

    async def clear(self) -> None:
        raise NotImplementedError

    async def close(self) -> None:
        self._closed = True
