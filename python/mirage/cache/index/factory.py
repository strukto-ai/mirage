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

from collections.abc import Callable

from mirage.cache.index.config import IndexConfig, RedisIndexConfig
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.index.store import IndexCacheStore

redis_store: Callable[..., IndexCacheStore] | None
try:
    from mirage.cache.index.redis import RedisIndexCacheStore
    redis_store = RedisIndexCacheStore
except ImportError:
    redis_store = None


def build_index(config: IndexConfig | None, ttl: float) -> IndexCacheStore:
    """The index store a mount runs its driver under.

    A mount builds one when it is placed, from the workspace or mount
    ``index`` config when there is one and from the driver's own
    ``index_ttl`` otherwise. Two mounts of one driver instance share
    the store the first one built; that sharing is the registry's.

    Args:
        config (IndexConfig | None): the configured store, or None for
            a RAM store at the driver's TTL.
        ttl (float): the driver's ``index_ttl``, read when ``config``
            is None.
    """
    if config is None:
        return RAMIndexCacheStore(ttl=ttl)
    if isinstance(config, RedisIndexConfig):
        if redis_store is None:
            raise ImportError("RedisIndexConfig requires the 'redis' extra. "
                              "Install with: pip install mirage-ai[redis]")
        return redis_store(ttl=config.ttl,
                           url=config.url,
                           key_prefix=config.key_prefix)
    return RAMIndexCacheStore(ttl=config.ttl)
