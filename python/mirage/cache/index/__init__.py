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

from typing import TYPE_CHECKING

from mirage.utils.loader import lazy_exports

if TYPE_CHECKING:
    from mirage.cache.index.config import (
        Evicted,
        IndexConfig,
        ListResult,
        LookupResult,
        LookupStatus,
        RedisIndexConfig,
    )
    from mirage.cache.index.null import NULL_INDEX, NullIndexCacheStore
    from mirage.cache.index.ram import RAMIndexCacheStore
    from mirage.cache.index.redis import RedisIndexCacheStore
    from mirage.cache.index.store import IndexCacheStore

_EXPORTS: dict[str, tuple[str, ...]] = {
    "mirage.cache.index.config": (
        "Evicted",
        "IndexConfig",
        "ListResult",
        "LookupResult",
        "LookupStatus",
        "RedisIndexConfig",
    ),
    "mirage.cache.index.null": ("NULL_INDEX", "NullIndexCacheStore"),
    "mirage.cache.index.ram": ("RAMIndexCacheStore",),
    "mirage.cache.index.redis": ("RedisIndexCacheStore",),
    "mirage.cache.index.store": ("IndexCacheStore",),
}

__all__ = [
    "Evicted",
    "IndexCacheStore",
    "IndexConfig",
    "ListResult",
    "LookupResult",
    "LookupStatus",
    "NULL_INDEX",
    "NullIndexCacheStore",
    "RAMIndexCacheStore",
    "RedisIndexCacheStore",
    "RedisIndexConfig",
]

__getattr__ = lazy_exports(__name__, _EXPORTS)
