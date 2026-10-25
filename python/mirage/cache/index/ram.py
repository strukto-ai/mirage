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
from collections.abc import Sequence
from datetime import datetime, timedelta, timezone

from mirage.cache.index.config import (
    Evicted,
    ListResult,
    LookupResult,
    LookupStatus,
)
from mirage.cache.index.store import IndexCacheStore
from mirage.cache.lock import KeyLockMixin
from mirage.types import FileStat, FileType
from mirage.utils.clock import Clock
from mirage.utils.key_prefix import under_path


class RAMIndexCacheStore(IndexCacheStore, KeyLockMixin):
    """In-memory index cache using plain dicts + asyncio locks.

    Args:
        ttl (float): seconds a listing lives when its writer names no expiry.
        clock (Clock | None): the clock expiries are stamped and compared
            on; None means the system clock.
    """

    def __init__(self, ttl: float = 600, clock: Clock | None = None) -> None:
        super().__init__(clock)
        self._ttl = ttl
        self._entries: dict[str, FileStat] = {}
        self._children: dict[str, list[str]] = {}
        self._folder_flags: dict[str, dict[str, bool]] = {}
        self._expiry: dict[str, datetime] = {}
        self._partial: set[str] = set()
        self._windows: set[str] = set()
        self._tombstones: dict[str, list[Evicted]] = {}
        self._versions: dict[str, str] = {}

    def seed(
        self,
        entries: dict[str, FileStat],
        children: dict[str, list[str]],
        expires_at: datetime,
        *,
        version: str | None = None,
    ) -> None:
        self._entries.update(entries)
        self._children.update(
            {path: list(keys) for path, keys in children.items()}
        )
        self._expiry.update({path: expires_at for path in children})
        self._partial.difference_update(children)
        self._windows.difference_update(children)
        for path, keys in children.items():
            self._folder_flags[path] = {
                child: child in self._children or self._is_folder(child)
                for child in keys
            }
            self._stamp(path, version)
        for path in children:
            self._remember_directory(path)

    def _stamp(self, vfs_path: str, version: str | None) -> None:
        if version is None:
            self._versions.pop(vfs_path, None)
        else:
            self._versions[vfs_path] = version

    async def entries(self) -> dict[str, FileStat]:
        return dict(self._entries)

    @property
    def ttl(self) -> float:
        return self._ttl

    async def get(self, vfs_path: str) -> LookupResult:
        entry = self._entries.get(vfs_path)
        if entry is None:
            return LookupResult(status=LookupStatus.NOT_FOUND)
        return LookupResult(entry=entry)

    async def put(self, vfs_path: str, entry: FileStat) -> None:
        folder = vfs_path.rsplit("/", 1)[0] or "/"
        async with self._lock_for(folder):
            if (
                self._is_folder(vfs_path)
                and entry.type is not FileType.DIRECTORY
            ):
                self._bury(folder, (vfs_path,))
            self._entries[vfs_path] = entry

    async def add_entry(
        self,
        vfs_path: str,
        entry: FileStat,
        expired_at: datetime | None = None,
    ) -> None:
        folder = vfs_path.rsplit("/", 1)[0] or "/"
        async with self._lock_for(folder):
            now = datetime.fromtimestamp(self.clock.now(), timezone.utc)
            children = self._children.get(folder, [])
            exp = self._expiry.get(folder)
            was_folder = self._is_folder(vfs_path) or self._folder_flags.get(
                folder, {}
            ).get(vfs_path, False)
            stale = folder not in self._children or exp is None or now >= exp
            if stale:
                self._bury(folder, tuple(children))
            if was_folder and entry.type is not FileType.DIRECTORY:
                self._bury(folder, (vfs_path,))
                self._partial.add(folder)
                self._windows.discard(folder)
                self._versions.pop(folder, None)
            self._entries[vfs_path] = entry
            if stale:
                lifetime = now + timedelta(seconds=self._ttl)
                self._children[folder] = [vfs_path]
                self._folder_flags[folder] = {}
                self._expiry[folder] = (
                    lifetime
                    if expired_at is None
                    else min(lifetime, expired_at)
                )
                self._partial.add(folder)
                self._windows.discard(folder)
                self._versions.pop(folder, None)
            elif vfs_path not in children:
                bisect.insort(children, vfs_path)
            self._folder_flags.setdefault(folder, {})[vfs_path] = (
                entry.type is FileType.DIRECTORY
            )

    async def replace_if_unchanged(
        self, vfs_path: str, predecessor: str, entry: FileStat
    ) -> bool:
        async with self._lock_for(vfs_path):
            current = self._entries.get(vfs_path)
            if current is None or current.model_dump() != json.loads(
                predecessor
            ):
                return False
            self._entries[vfs_path] = entry
            return True

    async def list_dir(
        self, vfs_path: str, child: str | None = None
    ) -> ListResult:
        exp = self._expiry.get(vfs_path)
        if exp is None:
            return ListResult(status=LookupStatus.NOT_FOUND)
        if datetime.fromtimestamp(self.clock.now(), timezone.utc) >= exp:
            return ListResult(status=LookupStatus.EXPIRED)
        if child is None:
            children = self._children.get(vfs_path) or []
        else:
            # A folder's flags name exactly the children its listing holds.
            named = child in self._folder_flags.get(vfs_path, {})
            children = [child] if named else []
        version = self._versions.get(vfs_path)
        if vfs_path in self._partial:
            return ListResult(partial_entries=children, version=version)
        return ListResult(
            entries=children,
            version=version,
            window=vfs_path in self._windows,
        )

    async def set_dir(
        self,
        vfs_path: str,
        entries: Sequence[tuple[str, FileStat]],
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
        entries: Sequence[tuple[str, FileStat]],
        expired_at: datetime | None = None,
    ) -> None:
        await self._set_dir(
            vfs_path, entries, expired_at, partial=True, evict=False
        )

    async def _set_dir(
        self,
        vfs_path: str,
        entries: Sequence[tuple[str, FileStat]],
        expired_at: datetime | None,
        *,
        partial: bool,
        evict: bool,
        excluded: tuple[str, ...] = (),
        version: str | None = None,
    ) -> list[Evicted]:
        async with self._lock_for(vfs_path):
            now = datetime.fromtimestamp(self.clock.now(), timezone.utc)
            exp = expired_at or (now + timedelta(seconds=self._ttl))
            prefix = "/" if vfs_path == "/" else vfs_path + "/"
            rows: dict[str, FileStat] = {
                prefix + name: entry for name, entry in entries
            }
            child_keys = list(rows)
            if partial:
                self._bury(
                    vfs_path,
                    (
                        *self._children.get(vfs_path, []),
                        *(
                            key
                            for key in rows
                            if key in self._children or self._is_folder(key)
                        ),
                    ),
                )
            buried = (
                {}
                if partial
                else {
                    child.path: child.folder
                    for child in self._tombstones.pop(vfs_path, [])
                }
            )
            candidates = dict.fromkeys(self._children.get(vfs_path, []))
            current_folders = self._folder_flags.get(vfs_path, {})
            candidates.update(dict.fromkeys(buried))
            candidates.update(dict.fromkeys(rows))
            gone = (
                [
                    self._evict(
                        key,
                        buried.get(key, False)
                        or current_folders.get(key, False),
                        excluded,
                    )
                    for key in candidates
                    if (
                        key not in rows
                        or (
                            rows[key].type is not FileType.DIRECTORY
                            and (
                                buried.get(key, False)
                                or current_folders.get(key, False)
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
            self._folder_flags[vfs_path] = {
                key: row.type is FileType.DIRECTORY
                for key, row in rows.items()
            }
            self._remember_directory(vfs_path)
            self._expiry[vfs_path] = exp
            self._stamp(vfs_path, None if partial else version)
            if partial:
                self._partial.add(vfs_path)
            else:
                self._partial.discard(vfs_path)
            if partial or evict:
                self._windows.discard(vfs_path)
            else:
                self._windows.add(vfs_path)
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
            or (entry is not None and entry.type is FileType.DIRECTORY)
        )
        if folder:
            self._drop_prefix(key, excluded=excluded)
        return Evicted(key, folder=folder)

    def _bury(self, vfs_path: str, paths: tuple[str, ...]) -> None:
        buried = {
            child.path: child.folder
            for child in self._tombstones.get(vfs_path, [])
        }
        for child in paths:
            buried[child] = (
                buried.get(child, False)
                or self._folder_flags.get(vfs_path, {}).get(child, False)
                or child in self._children
                or self._is_folder(child)
            )
        if buried:
            self._tombstones[vfs_path] = [
                Evicted(child, folder=folder)
                for child, folder in buried.items()
            ]

    def _remember_directory(self, vfs_path: str) -> None:
        vfs_path = vfs_path.rstrip("/")
        if not vfs_path:
            return
        parent = vfs_path.rsplit("/", 1)[0] or "/"
        flags = self._folder_flags.get(parent, {})
        if vfs_path in flags:
            flags[vfs_path] = True
        saved = self._tombstones.get(parent, [])
        if not any(child.path == vfs_path for child in saved):
            return
        remembered = [
            Evicted(child.path, folder=True)
            if child.path == vfs_path
            else child
            for child in saved
        ]
        self._tombstones[parent] = remembered

    async def invalidate_entry(self, vfs_path: str) -> None:
        folder = vfs_path.rsplit("/", 1)[0] or "/"
        async with self._lock_for(folder):
            self._bury(
                folder,
                (
                    *self._children.get(folder, []),
                    *(
                        (vfs_path,)
                        if vfs_path in self._children
                        or self._is_folder(vfs_path)
                        else ()
                    ),
                ),
            )
            self._entries.pop(vfs_path, None)
            children = self._children.get(folder)
            if children is not None:
                self._children[folder] = [
                    child for child in children if child != vfs_path
                ]
                self._partial.add(folder)
                self._windows.discard(folder)
                self._versions.pop(folder, None)
                self._folder_flags.get(folder, {}).pop(vfs_path, None)

    async def invalidate_dir(self, vfs_path: str) -> None:
        async with self._lock_for(vfs_path):
            self._bury(vfs_path, tuple(self._children.get(vfs_path, [])))
            for child in self._children.get(vfs_path, []):
                self._entries.pop(child, None)
            self._expiry.pop(vfs_path, None)
            self._children.pop(vfs_path, None)
            self._folder_flags.pop(vfs_path, None)
            self._partial.discard(vfs_path)
            self._windows.discard(vfs_path)
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
        return entry is not None and entry.type is FileType.DIRECTORY

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
            self._folder_flags.pop(dir_key, None)
        for exp_key in [
            k
            for k in self._expiry
            if under_path(k, vfs_path)
            and not any(under_path(k, p) for p in excluded)
        ]:
            self._expiry.pop(exp_key, None)
            self._partial.discard(exp_key)
            self._windows.discard(exp_key)
            self._versions.pop(exp_key, None)

    async def invalidate(self) -> None:
        past = datetime.fromtimestamp(
            self.clock.now(), timezone.utc
        ) - timedelta(seconds=1)
        for key in list(self._expiry):
            self._expiry[key] = past

    async def clear(self) -> None:
        self._entries.clear()
        self._children.clear()
        self._folder_flags.clear()
        self._expiry.clear()
        self._partial.clear()
        self._windows.clear()
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
        super().__init__(clock=hints.clock if hints is not None else None)
        self._hints = hints
        self.hinted_rows: dict[str, str] = {}

    async def hint(self, vfs_path: str) -> FileStat | None:
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
