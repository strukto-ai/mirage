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

from mirage.cache.index.config import (
    Evicted,
    IndexEntry,
    IndexSnapshot,
    ListResult,
    LookupResult,
)


class IndexCacheStore:
    """Per-VFS metadata index for remote mounts.

    Abstract base. Maps VFS paths to IndexEntry metadata.
    Subclasses implement storage and concurrency.
    """

    def __init__(self) -> None:
        super().__init__()
        self._closed = False

    @property
    def ttl(self) -> float:
        """Seconds a listing lives when its writer names no expiry."""
        raise NotImplementedError

    def scope_snapshot(self, snapshot: IndexSnapshot) -> IndexSnapshot:
        """Apply this index's ownership rules to a refill snapshot.

        Args:
            snapshot (IndexSnapshot): rows returned by the current refill.
        """
        return snapshot

    async def get(self, vfs_path: str) -> LookupResult:
        raise NotImplementedError

    def seed(
        self,
        entries: dict[str, IndexEntry],
        children: dict[str, list[str]],
        expires_at: datetime,
        *,
        version: str | None = None,
    ) -> None:
        """Merge a snapshot; flush deferred writes before operations or close.

        Repeated seeds merge by path. Clear discards queued snapshots.

        Args:
            entries (dict[str, IndexEntry]): rows by path.
            children (dict[str, list[str]]): each listed folder's children.
            expires_at (datetime): when the listings expire.
            version (str | None): the backend version the snapshot was read
                at; it replaces the version of every listed folder, and
                None clears it.
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
        *,
        window: bool = False,
        excluded: tuple[str, ...] = (),
        version: str | None = None,
    ) -> list[Evicted]:
        """Cache a complete directory listing.

        A complete listing names every child, so a child the previous
        listing named and this one does not is gone: its row goes, and a
        gone directory takes its listing and every row beneath it. Rows
        only ``put`` wrote were never named, so they stay. A window (the
        newest N messages, the last N days) is served as the listing but
        proves nothing absent, so it evicts nothing.

        Args:
            vfs_path (str): the listed directory's virtual path.
            entries (list[tuple[str, IndexEntry]]): every child.
            expired_at (datetime | None): optional freshness deadline.
            window (bool): the entries are a capped window, not every
                child.
            excluded (tuple[str, ...]): nested mount roots to preserve.
            version (str | None): the backend version the listing was read
                at; it replaces the stored one, and None clears it.

        Returns:
            list[Evicted]: the children the previous listing named and
            this one does not.
        """
        raise NotImplementedError

    async def report_gone(self, gone: list[Evicted]) -> None:
        """Hand children a re-list found gone to the mount's cleanup.

        A raw store belongs to no mount, so there is nothing to clean.

        Args:
            gone (list[Evicted]): the children the backend no longer has.
        """
        return None

    async def entries(self) -> dict[str, IndexEntry]:
        raise NotImplementedError

    async def set_partial_dir(
        self,
        vfs_path: str,
        entries: list[tuple[str, IndexEntry]],
        expired_at: datetime | None = None,
    ) -> None:
        """Cache observed children without claiming a complete directory.

        Stores supporting partial freshness return these keys under
        ``ListResult.partial_entries`` until expiry or invalidation. A
        partial listing proves nothing complete, so it carries no version.
        The default preserves the conservative put-only behavior for custom
        stores: their next lookup refreshes the parent.

        Args:
            vfs_path (str): the listed directory's virtual path.
            entries (list[tuple[str, IndexEntry]]): observed children.
            expired_at (datetime | None): optional freshness deadline.
        """
        await self.invalidate_dir(vfs_path)
        for name, entry in entries:
            await self.put(f"{vfs_path.rstrip('/')}/{name}", entry)

    async def invalidate_entry(self, vfs_path: str) -> None:
        """Drop one metadata row while preserving listing history.

        Args:
            vfs_path (str): mount-absolute entry key.
        """
        raise NotImplementedError

    async def invalidate_dir(self, vfs_path: str) -> None:
        raise NotImplementedError

    async def invalidate_prefix(
        self, vfs_path: str, *, excluded: tuple[str, ...] = ()
    ) -> None:
        """Drop ``vfs_path`` and everything cached below it.

        ``invalidate_dir`` drops one directory's listing and its direct
        children's entries, which is enough for a mutation that named a
        path. A push notification that can only name a scope needs the
        whole subtree gone, because the listings further down were
        cached independently and nothing above them expires them.

        Args:
            vfs_path (str): Mount-absolute root of the subtree.
            excluded (tuple[str, ...]): nested mount roots to preserve.
        """
        raise NotImplementedError

    async def holds_subtree(self, vfs_path: str) -> bool:
        """Whether a listing is cached at ``vfs_path`` or anywhere under it.

        Asked when a removed path may be a folder, to avoid a subtree scan
        for each plain-file delete. Only a retained listing counts, even
        one past its ttl (expiry is checked when it is read). A row or
        tombstone does not prove a listing remains below the path. A
        children-first delete stream may already have removed every
        listing before the folder's own event arrives.

        A store that cannot tell answers True, so callers conservatively
        drop the subtree and refetch it.

        Args:
            vfs_path (str): Mount-absolute path that was removed.
        """
        return True

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
