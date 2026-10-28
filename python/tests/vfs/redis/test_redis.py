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

import asyncio
import os

import pytest

from mirage import MountMode, Workspace
from mirage.vfs.errors import VFSConfigError
from mirage.vfs.redis import RedisVFS

REDIS_URL = os.environ.get("REDIS_URL", "")

URL = "redis://localhost:6379/0"


def test_url_spellings_of_one_keyspace_are_one_location():
    a = RedisVFS(url=URL, key_prefix="p:")
    b = RedisVFS(url="redis://127.0.0.1:6379", key_prefix="p:")
    assert a.storage_location() == b.storage_location()


def test_nested_prefixes_are_distinct_keyspaces():
    # Keys are {prefix}file:{path}: p/ holds p/file:/sub/x, p/sub/ holds
    # p/sub/file:/x, so /sub/x under one is not /x under the other.
    outer = RedisVFS(url=URL, key_prefix="p/").storage_location()
    inner = RedisVFS(url=URL, key_prefix="p/sub/").storage_location()
    assert outer + "/sub/x" != inner + "/x"


def test_a_trailing_slash_is_another_prefix():
    a = RedisVFS(url=URL, key_prefix="p").storage_location()
    b = RedisVFS(url=URL, key_prefix="p/").storage_location()
    assert a != b


def test_the_password_stays_out():
    vfs = RedisVFS(url="redis://u:secret@cache:6379/0")
    assert "secret" not in vfs.storage_location()


def test_a_capacity_that_is_not_a_size_is_refused():
    with pytest.raises(VFSConfigError, match="redis: capacity must be a size"):
        RedisVFS(capacity="5T")


@pytest.mark.asyncio
async def test_a_capped_redis_mount_refuses_growth_and_parallel_writers_stop_at_it(
    redis_prefix,
):
    if not REDIS_URL:
        pytest.skip("REDIS_URL not set")
    data = RedisVFS(url=REDIS_URL, key_prefix=redis_prefix, capacity=10)
    ws = Workspace({"/r": (data, MountMode.WRITE)})
    try:
        assert (await ws.shell("printf 1234567 > /r/a")).exit_code == 0
        assert (await ws.shell("printf 1234 > /r/b")).exit_code == 1
        results = await asyncio.gather(
            *(ws.shell(f"printf 1 > /r/p{i}") for i in range(10))
        )
        assert sum(r.exit_code == 0 for r in results) == 3
        assert data.usage is not None
        assert (data.usage.used, data.usage.pending) == (10, 0)
        assert (await data.capacity()).used == 10
        assert data.get_state()["config"]["capacity"] == 10
    finally:
        await data.accessor.store.clear()
        await ws.close()
