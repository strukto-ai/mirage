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

import pytest
import pytest_asyncio

from mirage.accessor.redis import RedisAccessor
from mirage.cache.index import RAMIndexCacheStore
from mirage.resource.redis.store import RedisStore

REDIS_URL = os.environ.get("REDIS_URL", "")


@pytest_asyncio.fixture()
async def store():
    # The env gate lives here because a `pytestmark` in a conftest is a
    # no-op (pytest only honors it in test modules): every module in this
    # directory goes through this fixture, so it skips rather than
    # erroring out of RedisStore's URL parse on machines without redis.
    if not REDIS_URL:
        pytest.skip("REDIS_URL not set")
    s = RedisStore(url=REDIS_URL, key_prefix="test:core:")
    await s.clear()
    await s.add_dir("/")
    a = RedisAccessor(s)
    yield a
    await s.clear()
    await s.close()


@pytest.fixture
def index():
    return RAMIndexCacheStore(ttl=600)
