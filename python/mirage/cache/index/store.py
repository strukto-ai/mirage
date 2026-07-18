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
    """

    def __init__(self) -> None:
        super().__init__()
        self._closed = False

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

    async def clear(self) -> None:
        raise NotImplementedError

    async def close(self) -> None:
        self._closed = True
