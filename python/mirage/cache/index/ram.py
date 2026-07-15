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

from datetime import datetime, timedelta, timezone

from mirage.cache.index.config import (IndexEntry, ListResult, LookupResult,
                                       LookupStatus)
from mirage.cache.index.store import IndexCacheStore
from mirage.cache.lock import KeyLockMixin
from mirage.core.timeutil import to_iso_z


class RAMIndexCacheStore(IndexCacheStore, KeyLockMixin):
    """In-memory index cache using plain dicts + asyncio locks."""

    def __init__(self, ttl: float = 600) -> None:
        super().__init__()
        self._ttl = ttl
        self._entries: dict[str, IndexEntry] = {}
        self._children: dict[str, list[str]] = {}
        self._expiry: dict[str, datetime] = {}

    def all_entries(self) -> dict[str, IndexEntry]:
        return self._entries

    async def get(self, resource_path: str) -> LookupResult:
        entry = self._entries.get(resource_path)
        if entry is None:
            return LookupResult(status=LookupStatus.NOT_FOUND)
        return LookupResult(entry=entry)

    async def put(self, resource_path: str, entry: IndexEntry) -> None:
        async with self._lock_for(resource_path):
            if not entry.index_time:
                entry = entry.model_copy(
                    update={
                        "index_time": to_iso_z(datetime.now(timezone.utc))
                    })
            self._entries[resource_path] = entry

    async def list_dir(self, resource_path: str) -> ListResult:
        exp = self._expiry.get(resource_path)
        if exp is None:
            return ListResult(status=LookupStatus.NOT_FOUND)
        if datetime.now(timezone.utc) > exp:
            return ListResult(status=LookupStatus.EXPIRED)
        children = self._children.get(resource_path)
        return ListResult(entries=children or [])

    async def set_dir(
        self,
        resource_path: str,
        entries: list[tuple[str, IndexEntry]],
        expired_at: datetime | None = None,
    ) -> None:
        async with self._lock_for(resource_path):
            now = datetime.now(timezone.utc)
            exp = expired_at or (now + timedelta(seconds=self._ttl))
            now_iso = to_iso_z(now)
            prefix = "/" if resource_path == "/" else resource_path + "/"
            child_keys: list[str] = []
            for name, entry in entries:
                full_path = prefix + name
                if not entry.index_time:
                    entry = entry.model_copy(update={"index_time": now_iso})
                self._entries[full_path] = entry
                child_keys.append(full_path)
            self._children[resource_path] = child_keys
            self._expiry[resource_path] = exp

    async def invalidate_dir(self, resource_path: str) -> None:
        for child in self._children.get(resource_path, []):
            self._entries.pop(child, None)
        self._expiry.pop(resource_path, None)
        self._children.pop(resource_path, None)

    async def clear(self) -> None:
        self._entries.clear()
        self._children.clear()
        self._expiry.clear()
        self._clear_locks()
