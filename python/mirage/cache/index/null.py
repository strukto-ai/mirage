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

from mirage.cache.index.config import (IndexEntry, ListResult, LookupResult,
                                       LookupStatus)
from mirage.cache.index.store import IndexCacheStore


class NullIndexCacheStore(IndexCacheStore):
    """A no-op index that never caches.

    Every lookup is a miss and every write is discarded, so callers behave
    exactly as if there were no cache: they fall through to the backend on
    reads and skip populating on writes. It exists so ``index`` can be a
    required, non-optional ``IndexCacheStore`` everywhere: a caller with no
    real index passes this instead of ``None``, and backends never branch
    on ``index is None``.
    """

    async def get(self, resource_path: str) -> LookupResult:
        return LookupResult(status=LookupStatus.NOT_FOUND)

    async def put(self, resource_path: str, entry: IndexEntry) -> None:
        return None

    async def list_dir(self, resource_path: str) -> ListResult:
        return ListResult(status=LookupStatus.NOT_FOUND)

    async def set_dir(
        self,
        resource_path: str,
        entries: list[tuple[str, IndexEntry]],
        expired_at: datetime | None = None,
    ) -> None:
        return None

    async def invalidate_dir(self, resource_path: str) -> None:
        return None

    async def clear(self) -> None:
        return None


NULL_INDEX = NullIndexCacheStore()
