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

from mirage.cache.file.config import CacheConfig
from mirage.utils.clock import ManualClock
from mirage.workspace.workspace.cache import build_file_cache


@pytest.mark.asyncio
async def test_built_cache_ages_entries_on_the_given_clock():
    clock = ManualClock(start=1000.0)
    cache = build_file_cache(None, "1MB", clock)
    await cache.set("/f.txt", b"hello", ttl=10)
    clock.advance(9)
    assert await cache.exists("/f.txt") is True
    clock.advance(1)
    assert await cache.exists("/f.txt") is False


@pytest.mark.asyncio
async def test_a_cache_config_does_not_lose_the_clock():
    clock = ManualClock(start=1000.0)
    cache = build_file_cache(CacheConfig(limit="2MB"), "1MB", clock)
    assert cache.cache_limit == 2 * 1024 * 1024
    await cache.set("/f.txt", b"hello", ttl=10)
    clock.advance(10)
    assert await cache.exists("/f.txt") is False
