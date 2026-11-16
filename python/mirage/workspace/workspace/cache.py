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

from mirage.cache.file.config import CacheConfig, RedisCacheConfig
from mirage.cache.file.constants import DEFAULT_KEY_PREFIX
from mirage.cache.file.mixin import FileCacheMixin
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.utils.clock import Clock
from mirage.utils.loader import optional_attr

if TYPE_CHECKING:
    from mirage.cache.file.redis import RedisFileCacheStore


def build_file_cache(
    cache: CacheConfig | None,
    clock: Clock | None = None,
    workspace_id: str | None = None,
) -> FileCacheMixin:
    """Build the workspace's file cache from its config.

    Args:
        cache (CacheConfig | None): the cache config; None keeps the
            default RAM store.
        clock (Clock | None): the workspace's clock, handed to the RAM
            store, which ages its entries itself. The redis store expires
            keys server-side and reads no time.
        workspace_id (str | None): scopes a redis store whose config
            names no prefix, so two workspaces on one server never read
            each other's files; None keeps the shared default.

    Raises:
        ImportError: a Redis cache was asked for without the extra.
    """
    if isinstance(cache, RedisCacheConfig):
        redis_store: type[RedisFileCacheStore] = optional_attr(
            "mirage.cache.file.redis:RedisFileCacheStore",
            "redis",
            "RedisCacheConfig",
        )
        return redis_store(
            cache_limit=cache.limit,
            url=cache.url,
            key_prefix=(
                cache.key_prefix
                if cache.key_prefix is not None
                else DEFAULT_KEY_PREFIX
                if workspace_id is None
                else f"{DEFAULT_KEY_PREFIX}{workspace_id}:"
            ),
            max_drain_bytes=cache.max_drain_bytes,
        )
    config = cache if cache is not None else CacheConfig()
    return RAMFileCacheStore(
        cache_limit=config.limit,
        max_drain_bytes=config.max_drain_bytes,
        clock=clock,
    )
