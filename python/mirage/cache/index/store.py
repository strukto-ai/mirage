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
    """Per-resource metadata index for remote resources.

    Abstract base. Maps resource paths to IndexEntry metadata.
    Subclasses implement storage and concurrency.

    ``fresh`` is False on every store a mount owns and True only on the
    private, empty one the dispatcher substitutes for a ``fresh`` op.
    It is the signal a backend reads when the memory it has to silence
    does not live in this store: sharepoint remembers site and drive
    ids on its accessor, so an empty index alone would not stop a
    deleted-and-recreated drive from answering with the old id. Nothing
    consults it for entries; it says only "no memory answers this one".

    Args:
        fresh (bool): whether this store stands in for a fresh op.
    """

    def __init__(self, fresh: bool = False) -> None:
        super().__init__()
        self._closed = False
        self.fresh = fresh

    async def get(self, resource_path: str) -> LookupResult:
        raise NotImplementedError

    def seed(self, entries: dict[str, IndexEntry],
             children: dict[str, list[str]], expires_at: datetime) -> None:
        """Queue a synchronous metadata snapshot for the next lookup."""
        raise NotImplementedError

    async def put(self, resource_path: str, entry: IndexEntry) -> None:
        raise NotImplementedError

    async def list_dir(self, resource_path: str) -> ListResult:
        raise NotImplementedError

    async def set_dir(
        self,
        resource_path: str,
        entries: list[tuple[str, IndexEntry]],
        expired_at: datetime | None = None,
    ) -> None:
        raise NotImplementedError

    async def entries(self) -> dict[str, IndexEntry]:
        raise NotImplementedError

    async def invalidate_dir(self, resource_path: str) -> None:
        raise NotImplementedError

    async def invalidate_prefix(self, resource_path: str) -> None:
        """Drop ``resource_path`` and everything cached below it.

        ``invalidate_dir`` drops one directory's listing and its direct
        children's entries, which is enough for a mutation that named a
        path. A push notification that can only name a scope needs the
        whole subtree gone, because the listings further down were
        cached independently and nothing above them expires them.

        Args:
            resource_path (str): Mount-absolute root of the subtree.
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
