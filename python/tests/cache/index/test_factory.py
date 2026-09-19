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

import pytest

from mirage.cache.index import (IndexConfig, RAMIndexCacheStore,
                                RedisIndexCacheStore, RedisIndexConfig)
from mirage.cache.index.config import LookupStatus
from mirage.cache.index.factory import build_index


@pytest.mark.asyncio
async def test_no_config_is_a_ram_store_at_the_driver_ttl():
    store = build_index(None, -1)
    assert isinstance(store, RAMIndexCacheStore)
    await store.set_dir("/listing", [])
    assert (await store.list_dir("/listing")).status == LookupStatus.EXPIRED


@pytest.mark.asyncio
async def test_config_ttl_wins_over_the_driver_ttl():
    store = build_index(IndexConfig(ttl=3600), -1)
    assert isinstance(store, RAMIndexCacheStore)
    await store.set_dir("/listing", [])
    assert (await store.list_dir("/listing")).status != LookupStatus.EXPIRED


def test_redis_config_builds_a_redis_store():
    store = build_index(
        RedisIndexConfig(url="redis://127.0.0.1:1/0", key_prefix="t:"), -1)
    assert isinstance(store, RedisIndexCacheStore)
