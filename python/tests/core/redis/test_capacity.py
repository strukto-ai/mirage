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

import os
from unittest.mock import AsyncMock, MagicMock

import pytest
from redis.exceptions import ResponseError

from mirage.accessor.redis import RedisAccessor
from mirage.core.redis.capacity import capacity
from mirage.types import CapacityResult, CapacityState
from mirage.vfs.redis.store import RedisStore

REDIS_URL = os.environ.get("REDIS_URL", "")


def _accessor(answer: dict | Exception) -> RedisAccessor:
    store = MagicMock(spec=RedisStore)
    if isinstance(answer, Exception):
        store.info_memory = AsyncMock(side_effect=answer)
    else:
        store.info_memory = AsyncMock(return_value=answer)
    return RedisAccessor(store)


@pytest.mark.asyncio
async def test_a_memory_limit_is_the_capacity():
    info = {"used_memory": 300, "maxmemory": 1000, "used_memory_human": "300B"}
    assert await capacity(_accessor(info)) == CapacityResult(
        state=CapacityState.QUOTA, total=1000, used=300, available=700
    )


@pytest.mark.asyncio
async def test_memory_past_the_limit_leaves_nothing_available():
    info = {"used_memory": 1200, "maxmemory": 1000}
    assert await capacity(_accessor(info)) == CapacityResult(
        state=CapacityState.QUOTA, total=1000, used=1200, available=0
    )


@pytest.mark.asyncio
async def test_no_limit_is_elastic():
    info = {"used_memory": 300, "maxmemory": 0}
    assert await capacity(_accessor(info)) == CapacityResult(
        state=CapacityState.ELASTIC
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "answer",
    [
        {"used_memory": 300},
        {"maxmemory": 1000},
        {"used_memory": "300", "maxmemory": 1000},
        ResponseError("unknown command 'INFO'"),
    ],
)
async def test_a_server_that_does_not_say_is_unknown(answer):
    assert await capacity(_accessor(answer)) == CapacityResult(
        state=CapacityState.UNKNOWN
    )


@pytest.mark.asyncio
@pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")
async def test_a_live_server_reports_its_memory(redis_prefix):
    store = RedisStore(url=REDIS_URL, key_prefix=redis_prefix)
    try:
        result = await capacity(RedisAccessor(store))
    finally:
        await store.close()
    assert result.state in (CapacityState.QUOTA, CapacityState.ELASTIC)
