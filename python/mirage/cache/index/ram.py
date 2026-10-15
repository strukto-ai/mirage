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

import bisect
import json
from datetime import datetime, timedelta, timezone

from mirage.cache.index.config import (
    Evicted,
    IndexRow,
    ListResult,
    LookupResult,
    LookupStatus,
    row_is_file,
    row_is_folder,
    stamped,
)
from mirage.cache.index.store import IndexCacheStore
from mirage.cache.lock import KeyLockMixin
from mirage.utils.dates import to_iso_z
from mirage.utils.key_prefix import under_path


class RAMIndexCacheStore(IndexCacheStore, KeyLockMixin):
    """In-memory index cache using plain dicts + asyncio locks."""

    def __init__(self, ttl: float = 600) -> None:
        super().__init__()
        self._ttl = ttl
        self._entries: dict[str, IndexRow] = {}
        self._children: dict[str, list[str]] = {}
        self._expiry: dict[str, datetime] = {}
        self._partial: set[str] = set()
        self._tombstones: dict[str, list[Evicted]] = {}
        self._versions: dict[str, str] = {}

    def seed(
        self,
        entries: dict[str, IndexRow],
        children: dict[str, list[str]],
        expires_at: datetime,
        *,
        version: str | None = None,
    ) -> None:
        now_iso = to_iso_z(datetime.now(timezone.utc))
        self._entries.update(
            {path: stamped(entry, now_iso) for path, entry in entries.items()}
        )
        self._children.update(
            {path: list(keys) for path, keys in children.items()}
        )
        self._expiry.update({path: expires_at for path in children})
        self._partial.difference_update(children)
        for path in children:
            self._stamp(path, version)

    def _stamp(self, vfs_path: str, version: str | None) -> None:
        if version is None:
            self._versions.pop(vfs_path, None)
        else:
            self._versions[vfs_path] = version

    async def entries(self) -> dict[str, IndexRow]:
        return dict(self._entries)

    @property
    def ttl(self) -> float:
        return self._ttl

    async def get(self, vfs_path: str) -> LookupResult:
        entry = self._entries.get(vfs_path)
        if entry is None:
            return LookupResult(status=LookupStatus.NOT_FOUND)
        return LookupResult(entry=entry)

    async def put(self, vfs_path: str, entry: IndexRow) -> None:
        async with self._lock_for(vfs_path):
            self._entries[vfs_path] = stamped(
                entry, to_iso_z(datetime.now(timezone.utc))
            )

    async def add_entry(self, vfs_path: str, entry: IndexRow) -> None:
        folder = vfs_path.rsplit("/", 1)[0] or "/"
        async with self._lock_for(folder):
            now = datetime.now(timezone.utc)
            self._entries[vfs_path] = stamped(entry, to_iso_z(now))
            children = self._children.get(folder)
            exp = self._expiry.get(folder)
            if children is None or exp is None or now >= exp:
                self._children[folder] = [vfs_path]
                self._expiry[folder] = now + timedelta(seconds=self._ttl)
                self._partial.add(folder)
                self._versions.pop(folder, None)
            elif vfs_path not in children:
                bisect.insort(children, vfs_path)

    async def replace_if_unchanged(
        self, vfs_path: str, predecessor: str, entry: IndexRow
    ) -> bool:
        async with self._lock_for(vfs_path):
            current = self._entries.get(vfs_path)
            if current is None or current.model_dump() != json.loads(
                predecessor
            ):
                return False
            self._entries[vfs_path] = stamped(
                entry, to_iso_z(datetime.now(timezone.utc))
            )
            return True

    async def list_dir(self, vfs_path: str) -> ListResult:
        exp = self._expiry.get(vfs_path)
        if exp is None:
            return ListResult(status=LookupStatus.NOT_FOUND)
        if datetime.now(timezone.utc) >= exp:
            return ListResult(status=LookupStatus.EXPIRED)
        children = self._children.get(vfs_path)
        version = self._versions.get(vfs_path)
        if vfs_path in self._partial:
            return ListResult(partial_entries=children or [], version=version)
        return ListResult(entries=children or [], version=version)

    async def set_dir(
        self,
        vfs_path: str,
        entries: list[tuple[str, IndexRow]],
        expired_at: datetime | None = None,
        *,
        window: bool = False,
        excluded: tuple[str, ...] = (),
        version: str | None = None,
    ) -> list[Evicted]:
        return await self._set_dir(
            vfs_path,
            entries,
            expired_at,
            partial=False,
            evict=not window,
            excluded=excluded,
            version=version,
        )

    async def set_partial_dir(
        self,
        vfs_path: str,
        entries: list[tuple[str, IndexRow]],
        expired_at: datetime | None = None,
    ) -> None:
        await self._set_dir(
            vfs_path, entries, expired_at, partial=True, evict=False
        )

    async def _set_dir(
        self,
        vfs_path: str,
        entries: list[tuple[str, IndexRow]],
        expired_at: datetime | None,
        *,
        partial: bool,
        evict: bool,
        excluded: tuple[str, ...] = (),
        version: str | None = None,
    ) -> list[Evicted]:
        async with self._lock_for(vfs_path):
            now = datetime.now(timezone.utc)
            exp = expired_at or (now + timedelta(seconds=self._ttl))
            now_iso = to_iso_z(now)
            prefix = "/" if vfs_path == "/" else vfs_path + "/"
            rows: dict[str, IndexRow] = {
                prefix + name: stamped(entry, now_iso)
                for name, entry in entries
            }
            child_keys = list(rows)
            # What the last full knowledge named: the current listing, plus a
            # tombstone an invalidation left (a partial since then cannot
            # have proven its other children gone).
            buried = (
                {}
                if partial
                else {
                    child.path: child.folder
                    for child in self._tombstones.pop(vfs_path, [])
                }
            )
            candidates = dict.fromkeys(self._children.get(vfs_path, []))
            candidates.update(dict.fromkeys(buried))
            candidates.update(dict.fromkeys(rows))
            gone = (
                [
                    self._evict(key, buried.get(key, False), excluded)
                    for key in candidates
                    if (
                        key not in rows
                        or (
                            row_is_file(rows[key])
                            and (
                                buried.get(key, False)
                                or key in self._children
                                or self._is_folder(key)
                            )
                        )
                    )
                    and not any(under_path(key, p) for p in excluded)
                ]
                if evict
                else []
            )
            self._entries.update(rows)
            self._children[vfs_path] = child_keys
            self._expiry[vfs_path] = exp
            self._stamp(vfs_path, None if partial else version)
            if partial:
                self._partial.add(vfs_path)
            else:
                self._partial.discard(vfs_path)
            return gone

    def _evict(
        self,
        key: str,
        buried_folder: bool = False,
        excluded: tuple[str, ...] = (),
    ) -> Evicted:
        """Drop a child a complete listing no longer names.

        Args:
            key (str): the gone child's key.
            buried_folder (bool): a tombstone recorded it as a folder,
                after its row was already dropped.
            excluded (tuple[str, ...]): nested mount roots to preserve.
        """
        entry = self._entries.pop(key, None)
        folder = (
            buried_folder
            or key in self._children
            or (entry is not None and row_is_folder(entry))
        )
        if folder:
            self._drop_prefix(key, excluded=excluded)
        return Evicted(key, folder=folder)

    async def invalidate_entry(self, vfs_path: str) -> None:
        self._entries.pop(vfs_path, None)

    async def invalidate_dir(self, vfs_path: str) -> None:
        # The child list is kept as a tombstone, so the next complete
        # listing can still tell which children went away.
        children = self._children.get(vfs_path)
        if children is not None:
            buried = (
                {
                    child.path: child.folder
                    for child in self._tombstones.get(vfs_path, [])
                }
                if vfs_path in self._partial
                else {}
            )
            for child in children:
                buried[child] = (
                    buried.get(child, False)
                    or child in self._children
                    or self._is_folder(child)
                )
            self._tombstones[vfs_path] = [
                Evicted(child, folder=folder)
                for child, folder in buried.items()
            ]
        for child in children or []:
            self._entries.pop(child, None)
        self._expiry.pop(vfs_path, None)
        self._children.pop(vfs_path, None)
        self._partial.discard(vfs_path)
        self._versions.pop(vfs_path, None)

    async def invalidate_prefix(
        self, vfs_path: str, *, excluded: tuple[str, ...] = ()
    ) -> None:
        # Forgetting what is cached is not evidence that anything went away,
        # so an existing tombstone survives for the next complete listing.
        self._drop_prefix(vfs_path, keep_tombstones=True, excluded=excluded)

    async def holds_subtree(self, vfs_path: str) -> bool:
        return any(under_path(key, vfs_path) for key in self._children)

    def _is_folder(self, key: str) -> bool:
        entry = self._entries.get(key)
        return entry is not None and row_is_folder(entry)

    def _drop_prefix(
        self,
        vfs_path: str,
        *,
        keep_tombstones: bool = False,
        excluded: tuple[str, ...] = (),
    ) -> None:
        if not keep_tombstones:
            for tomb_key in [
                k
                for k in self._tombstones
                if under_path(k, vfs_path)
                and not any(under_path(k, p) for p in excluded)
            ]:
                self._tombstones.pop(tomb_key, None)
        for entry_key in [
            k
            for k in self._entries
            if under_path(k, vfs_path)
            and not any(under_path(k, p) for p in excluded)
        ]:
            self._entries.pop(entry_key, None)
        for dir_key in [
            k
            for k in self._children
            if under_path(k, vfs_path)
            and not any(under_path(k, p) for p in excluded)
        ]:
            self._children.pop(dir_key, None)
        for exp_key in [
            k
            for k in self._expiry
            if under_path(k, vfs_path)
            and not any(under_path(k, p) for p in excluded)
        ]:
            self._expiry.pop(exp_key, None)
            self._partial.discard(exp_key)
            self._versions.pop(exp_key, None)

    async def invalidate(self) -> None:
        past = datetime.now(timezone.utc) - timedelta(seconds=1)
        for key in list(self._expiry):
            self._expiry[key] = past

    async def clear(self) -> None:
        self._entries.clear()
        self._children.clear()
        self._expiry.clear()
        self._partial.clear()
        self._tombstones.clear()
        self._versions.clear()
        self._clear_locks()


class ListingCheckStore(RAMIndexCacheStore):
    """The empty, throwaway store a ``read: fresh`` check stats through.

    The listing gate and the read probe pass it to say a request is what
    they want. A root stat asks the backend for its head only through this
    store. Through any other index it names no version and reads nothing,
    so a getattr of the root never sends a request or reads the index. A
    backend that lists a parent to answer a miss may ask for the one path
    instead, since the store is dropped right after.
    """

    def __init__(self, hints: IndexCacheStore | None = None) -> None:
        super().__init__()
        self._hints = hints
        self.hinted_rows: dict[str, str] = {}

    async def hint(self, vfs_path: str) -> IndexRow | None:
        """Offer the mount row as a lead the backend must confirm live.

        Args:
            vfs_path (str): mount-absolute key of the path being checked.
        """
        if self._hints is None:
            return None
        entry = (await self._hints.get(vfs_path)).entry
        if entry is not None:
            self.hinted_rows[vfs_path] = entry.model_dump_json()
        return entry
