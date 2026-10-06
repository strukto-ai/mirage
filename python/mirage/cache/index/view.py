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

from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager, nullcontext
from datetime import datetime, timedelta, timezone

from mirage.cache.file.io import mutation_lock
from mirage.cache.file.mixin import FileCacheMixin
from mirage.cache.index.config import (
    Evicted,
    IndexEntry,
    IndexSnapshot,
    ListResult,
    LookupResult,
    LookupStatus,
)
from mirage.cache.index.store import IndexCacheStore


class IndexView(IndexCacheStore):
    """A mount-owned view over a VFS's metadata index.

    Backend calls retain this view across awaits. Ownership is checked under
    the same lock that retires mount cache state, so late metadata writes
    cannot refill a replacement mount's index.
    """

    def __init__(
        self,
        store: IndexCacheStore,
        cache: FileCacheMixin,
        prefix: str,
        owns: Callable[[str], bool],
        *,
        locked: bool = False,
        read_ttl: float | None = None,
        on_gone: Callable[[list[Evicted]], Awaitable[None]] | None = None,
        may_serve_listing: Callable[[str, str | None], Awaitable[bool]]
        | None = None,
        note_written: Callable[[str], None] | None = None,
        excluded_prefixes: Callable[[], tuple[str, ...]] = tuple,
    ) -> None:
        """Args:
        store (IndexCacheStore): the VFS's own index.
        cache (FileCacheMixin): workspace file cache whose mutation lock
            fences these writes.
        prefix (str): mount prefix.
        owns (Callable[[str], bool]): whether this mount still owns a
            key.
        locked (bool): skip the non-reentrant mutation lock already
            held by the caller; the view must not outlive that hold.
        read_ttl (float | None): listing lifetime cap, or None.
        on_gone (Callable[[list[Evicted]], Awaitable[None]] | None): the
            mount's cleanup for the children a re-list found gone, or None.
        may_serve_listing (Callable[[str, str | None], Awaitable[bool]]
            | None): the mount's listing gate, asked with the folder and
            its stored version before a cached listing is served; None
            serves every cached listing.
        note_written (Callable[[str], None] | None): told each folder
            whose listing this view has just written.
        excluded_prefixes (Callable[[], tuple[str, ...]]): live nested
            mount roots protected from recursive deletion.
        """
        super().__init__()
        self._store = store
        self._cache = cache
        self._prefix = prefix or "/"
        self._owns = owns
        self._locked = locked
        self._read_ttl = read_ttl
        self._on_gone = on_gone
        self._may_serve_listing = may_serve_listing
        self._note_written = note_written
        self._excluded_prefixes = excluded_prefixes

    @property
    def store(self) -> IndexCacheStore:
        """The store this view writes through."""
        return self._store

    @property
    def ttl(self) -> float:
        if self._read_ttl is None:
            return self._store.ttl
        return min(self._store.ttl, self._read_ttl)

    def _fence(self) -> AbstractAsyncContextManager[None]:
        return nullcontext() if self._locked else mutation_lock(self._cache)

    def _deadline(self, expired_at: datetime | None) -> datetime | None:
        """Cap the expiry, preserving the store's default when it is shorter.

        Args:
            expired_at (datetime | None): the expiry the writer asked for.
        """
        if expired_at is not None:
            return self._cap(expired_at)
        if self._read_ttl is None or self._store.ttl <= self._read_ttl:
            return None
        return datetime.now(timezone.utc) + timedelta(seconds=self._read_ttl)

    def _cap(self, at: datetime) -> datetime:
        """Shorten an explicit expiry to this mount's bound.

        Args:
            at (datetime): the expiry the writer asked for.
        """
        if self._read_ttl is None:
            return at
        return min(
            at, datetime.now(timezone.utc) + timedelta(seconds=self._read_ttl)
        )

    async def get(self, vfs_path: str) -> LookupResult:
        # A lookup may flush a queued snapshot, so reads share the write fence.
        async with self._fence():
            if not self._owns(vfs_path):
                return LookupResult(status=LookupStatus.NOT_FOUND)
            result = await self._store.get(vfs_path)
            return (
                result
                if self._owns(vfs_path)
                else LookupResult(status=LookupStatus.NOT_FOUND)
            )

    async def list_dir(self, vfs_path: str) -> ListResult:
        result = await self._fenced_list_dir(vfs_path)
        # Asked outside the fence, since a gate may reach the backend, and
        # only about a listing the store has: a NOT_FOUND must stay one.
        # A refusal leaves the listing stored for the re-list to diff.
        if (
            self._may_serve_listing is not None
            and (
                result.entries is not None
                or result.partial_entries is not None
            )
            and not await self._may_serve_listing(vfs_path, result.version)
        ):
            return ListResult(status=LookupStatus.EXPIRED)
        return result

    async def _fenced_list_dir(self, vfs_path: str) -> ListResult:
        async with self._fence():
            if not self._owns(vfs_path):
                return ListResult(status=LookupStatus.NOT_FOUND)
            result = await self._store.list_dir(vfs_path)
            if not self._owns(vfs_path):
                return ListResult(status=LookupStatus.NOT_FOUND)
            return result.model_copy(
                update={
                    "entries": None
                    if result.entries is None
                    else [path for path in result.entries if self._owns(path)],
                    "partial_entries": None
                    if result.partial_entries is None
                    else [
                        path
                        for path in result.partial_entries
                        if self._owns(path)
                    ],
                }
            )

    async def put(self, vfs_path: str, entry: IndexEntry) -> None:
        async with self._fence():
            if self._owns(vfs_path):
                await self._store.put(vfs_path, entry)

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
        gone = await self._set_dir(
            vfs_path,
            entries,
            expired_at,
            partial=False,
            window=window,
            excluded=excluded,
            version=version,
        )
        await self.report_gone(gone)
        return gone

    async def set_partial_dir(
        self,
        vfs_path: str,
        entries: list[tuple[str, IndexEntry]],
        expired_at: datetime | None = None,
    ) -> None:
        await self._set_dir(
            vfs_path, entries, expired_at, partial=True, window=False
        )

    async def _set_dir(
        self,
        vfs_path: str,
        entries: list[tuple[str, IndexEntry]],
        expired_at: datetime | None,
        *,
        partial: bool,
        window: bool,
        excluded: tuple[str, ...] = (),
        version: str | None = None,
    ) -> list[Evicted]:
        async with self._fence():
            if not self._owns(vfs_path):
                return []
            prefix = vfs_path.rstrip("/") + "/"
            owned = [
                (name, entry)
                for name, entry in entries
                if self._owns(prefix + name)
            ]
            deadline = self._deadline(expired_at)
            if partial:
                await self._store.set_partial_dir(vfs_path, owned, deadline)
                self._noted(vfs_path)
                return []
            gone = await self._store.set_dir(
                vfs_path,
                owned,
                deadline,
                window=window,
                excluded=excluded + self._excluded_prefixes(),
                version=version,
            )
            self._noted(vfs_path)
            return [child for child in gone if self._owns(child.path)]

    def _noted(self, vfs_path: str) -> None:
        # After the store holds it, never before: a reader trusting the note
        # must find the listing the note is about.
        if self._note_written is not None:
            self._note_written(vfs_path)

    async def report_gone(self, gone: list[Evicted]) -> None:
        # Outside the fence: cleanup evicts file-cache entries, and the
        # mount table can change after the write, so ownership is asked
        # again at the moment of cleanup.
        if self._on_gone is None:
            return
        owned = [child for child in gone if self._owns(child.path)]
        if owned:
            await self._on_gone(owned)

    def scope_snapshot(self, snapshot: IndexSnapshot) -> IndexSnapshot:
        return IndexSnapshot(
            entries={
                path: entry
                for path, entry in snapshot.entries.items()
                if self._owns(path)
            },
            children={
                path: [key for key in keys if self._owns(key)]
                for path, keys in snapshot.children.items()
                if self._owns(path)
            },
            version=snapshot.version,
        )

    def seed(
        self,
        entries: dict[str, IndexEntry],
        children: dict[str, list[str]],
        expires_at: datetime,
        *,
        version: str | None = None,
    ) -> None:
        if not self._owns(self._prefix):
            return
        snapshot = self.scope_snapshot(
            IndexSnapshot(entries, children, version)
        )
        self._store.seed(
            snapshot.entries,
            snapshot.children,
            self._cap(expires_at),
            version=snapshot.version,
        )
        for folder in snapshot.children:
            self._noted(folder)

    async def entries(self) -> dict[str, IndexEntry]:
        async with self._fence():
            if not self._owns(self._prefix):
                return {}
            entries = await self._store.entries()
            return {
                path: entry
                for path, entry in entries.items()
                if self._owns(path)
            }

    async def invalidate_entry(self, vfs_path: str) -> None:
        async with self._fence():
            if self._owns(vfs_path):
                await self._store.invalidate_entry(vfs_path)

    async def invalidate_dir(self, vfs_path: str) -> None:
        async with self._fence():
            if self._owns(vfs_path):
                await self._store.invalidate_dir(vfs_path)

    async def invalidate_prefix(
        self, vfs_path: str, *, excluded: tuple[str, ...] = ()
    ) -> None:
        async with self._fence():
            if self._owns(vfs_path):
                await self._store.invalidate_prefix(
                    vfs_path, excluded=excluded + self._excluded_prefixes()
                )

    async def holds_subtree(self, vfs_path: str) -> bool:
        # No ownership filter: answering False for a path a nested mount
        # owns would keep that subtree cached, the non-conservative way.
        async with self._fence():
            return await self._store.holds_subtree(vfs_path)

    async def invalidate(self) -> None:
        async with self._fence():
            if self._owns(self._prefix):
                await self._store.invalidate()

    async def clear(self) -> None:
        await self.invalidate_prefix(self._prefix)
