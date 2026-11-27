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

from datetime import datetime, timezone

from mirage.cache.index import Evicted
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.types import FileStat

_EPOCH = datetime.fromtimestamp(0, timezone.utc)


class _ExpiredOnArrival(RAMIndexCacheStore):
    def __init__(self, live: frozenset[str]) -> None:
        super().__init__()
        self.live = live

    def seed(
        self,
        entries: dict[str, FileStat],
        children: dict[str, list[str]],
        expires_at: datetime,
        *,
        version: str | None = None,
    ) -> None:
        super().seed(entries, children, expires_at, version=version)
        for path in children:
            if path not in self.live:
                self._expiry[path] = _EPOCH

    async def _set_dir(
        self,
        vfs_path: str,
        entries: list[tuple[str, FileStat]],
        expired_at: datetime | None,
        *,
        partial: bool,
        evict: bool,
        excluded: tuple[str, ...] = (),
        version: str | None = None,
        refill: str | None = None,
    ) -> list[Evicted] | None:
        return await super()._set_dir(
            vfs_path,
            entries,
            expired_at if vfs_path in self.live else _EPOCH,
            partial=partial,
            evict=evict,
            excluded=excluded,
            version=version,
            refill=refill,
        )


def expired_on_arrival(*live: str) -> RAMIndexCacheStore:
    """An index whose listings are already expired when they land.

    Args:
        live (str): listing keys stored with the expiry their writer asked
            for, so a test can keep the mount root live.
    """
    return _ExpiredOnArrival(frozenset(live))
