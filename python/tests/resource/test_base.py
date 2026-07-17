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

from mirage.accessor.base import Accessor
from mirage.cache.index import (RAMIndexCacheStore, RedisIndexCacheStore,
                                RedisIndexConfig)
from mirage.resource.base import BaseResource
from mirage.resource.ram import RAMResource


class ClosingAccessor(Accessor):

    def __init__(self) -> None:
        self.close_calls = 0

    async def close(self) -> None:
        self.close_calls += 1


def test_default_index_is_ram():
    r = RAMResource()
    assert isinstance(r.index, RAMIndexCacheStore)


def test_set_index_redis():
    r = RAMResource()
    r.set_index(RedisIndexConfig(url="redis://localhost:6379/0"))
    assert isinstance(r.index, RedisIndexCacheStore)


def test_set_index_none_resets_to_ram():
    r = RAMResource()
    r.set_index(RedisIndexConfig(url="redis://localhost:6379/0"))
    r.set_index(None)
    assert isinstance(r.index, RAMIndexCacheStore)


def test_missing_accessor_attribute_raises():
    with pytest.raises(AttributeError):
        Accessor().missing_operation


@pytest.mark.asyncio
async def test_close_releases_accessor_once():
    resource = BaseResource()
    accessor = ClosingAccessor()
    resource.accessor = accessor

    await resource.close()
    await resource.close()

    assert accessor.close_calls == 1
