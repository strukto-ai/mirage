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

from mirage.observe.observer import Observer
from mirage.observe.redis_store import RedisObserverStore
from mirage.observe.store import ObserverStore

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def store(redis_prefix):
    s = RedisObserverStore(url=REDIS_URL, key_prefix=redis_prefix)
    await s.clear()
    yield s
    await s.clear()


@pytest.mark.asyncio
async def test_append_creates_and_extends(store):
    await store.append("/d/s.jsonl", b"a\n")
    await store.append("/d/s.jsonl", b"b\n")
    files = await store.read_all()
    assert files == {"/d/s.jsonl": b"a\nb\n"}


@pytest.mark.asyncio
async def test_write_overwrites(store):
    await store.append("/d/s.jsonl", b"old\n")
    await store.write("/d/s.jsonl", b"new\n")
    files = await store.read_all()
    assert files == {"/d/s.jsonl": b"new\n"}


@pytest.mark.asyncio
async def test_clear_empties_namespace(store):
    await store.append("/d/a.jsonl", b"x\n")
    await store.append("/d/b.jsonl", b"y\n")
    await store.clear()
    assert await store.read_all() == {}


@pytest.mark.asyncio
async def test_observer_over_redis_round_trip(store):
    obs = Observer(store=store)
    await obs.log_clear(session="s1")
    events = await obs.events()
    assert events[-1]["type"] == "clear"
    assert events[-1]["session"] == "s1"


def test_redis_store_satisfies_protocol(redis_prefix):
    assert isinstance(
        RedisObserverStore(url=REDIS_URL, key_prefix=redis_prefix),
        ObserverStore,
    )


@pytest.mark.asyncio
async def test_read_matching_filters_by_suffix(store):
    await store.append("/d1/s1.jsonl", b"a\n")
    await store.append("/d1/s2.jsonl", b"b\n")
    await store.append("/d2/s1.jsonl", b"c\n")
    files = await store.read_matching("/s1.jsonl")
    assert files == {"/d1/s1.jsonl": b"a\n", "/d2/s1.jsonl": b"c\n"}
