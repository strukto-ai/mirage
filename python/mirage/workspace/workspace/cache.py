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

from typing import Any

from mirage.cache.file.config import CacheConfig, RedisCacheConfig
from mirage.cache.file.mixin import FileCacheMixin
from mirage.cache.file.ram import RAMFileCacheStore

RedisFileCacheStore: Any
try:
    from mirage.cache.file.redis import \
        RedisFileCacheStore as _RedisFileCacheStore
except ImportError:
    RedisFileCacheStore = None
else:
    RedisFileCacheStore = _RedisFileCacheStore


def build_file_cache(cache: CacheConfig | None,
                     cache_limit: str | int) -> FileCacheMixin:
    """Build the workspace's file cache from its config.

    Args:
        cache (CacheConfig | None): the cache config; None keeps the
            RAM store sized by ``cache_limit``.
        cache_limit (str | int): the legacy size knob, used only when
            no config is given.

    Raises:
        ImportError: a Redis cache was asked for without the extra.
    """
    if isinstance(cache, RedisCacheConfig):
        if RedisFileCacheStore is None:
            raise ImportError("RedisCacheConfig requires the 'redis' extra. "
                              "Install with: pip install mirage-ai[redis]")
        return RedisFileCacheStore(
            cache_limit=cache.limit,
            url=cache.url,
            key_prefix=cache.key_prefix,
            max_drain_bytes=cache.max_drain_bytes,
        )
    limit = cache.limit if cache is not None else cache_limit
    max_drain = cache.max_drain_bytes if cache is not None else None
    return RAMFileCacheStore(cache_limit=limit, max_drain_bytes=max_drain)
