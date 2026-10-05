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

import pytest

from mirage.cache.lock import KeyLock, KeyLockMixin


class _Store(KeyLockMixin):
    pass


@pytest.mark.asyncio
async def test_different_keys_return_different_locks():
    store = _Store()
    assert store._lock_for("/a") is not store._lock_for("/b")


@pytest.mark.asyncio
async def test_same_key_returns_same_lock():
    store = _Store()
    assert store._lock_for("/a") is store._lock_for("/a")


@pytest.mark.asyncio
async def test_discard_lock_removes_key():
    store = _Store()
    store._lock_for("/a")
    store._discard_lock("/a")
    assert "/a" not in store._key_locks


@pytest.mark.asyncio
async def test_discard_lock_missing_key_no_error():
    store = _Store()
    store._discard_lock("/nope")


@pytest.mark.asyncio
async def test_clear_locks_removes_all():
    store = _Store()
    store._lock_for("/a")
    store._lock_for("/b")
    store._clear_locks()
    assert len(store._key_locks) == 0


@pytest.mark.asyncio
async def test_concurrent_different_keys_no_block():
    store = _Store()
    order = []

    async def acquire(key, label):
        async with store._lock_for(key):
            order.append(f"{label}_start")
            await asyncio.sleep(0)
            order.append(f"{label}_end")

    await asyncio.gather(acquire("/a", "a"), acquire("/b", "b"))
    assert "a_start" in order
    assert "b_start" in order


@pytest.mark.asyncio
async def test_same_key_serialized():
    store = _Store()
    order = []

    async def acquire(label):
        async with store._lock_for("/same"):
            order.append(f"{label}_start")
            await asyncio.sleep(0.01)
            order.append(f"{label}_end")

    await asyncio.gather(acquire("first"), acquire("second"))
    assert order[0] == "first_start"
    assert order[1] == "first_end"
    assert order[2] == "second_start"
    assert order[3] == "second_end"


async def _section(lock: KeyLock, key: str, name: str, order: list[str]):
    async with lock.with_lock(key):
        order.append(f"{name}_start")
        await asyncio.sleep(0.01)
        order.append(f"{name}_end")


@pytest.mark.asyncio
async def test_key_lock_runs_one_caller_at_a_time_per_key():
    lock = KeyLock()
    order: list[str] = []
    await asyncio.gather(
        _section(lock, "/same", "first", order),
        _section(lock, "/same", "second", order),
    )
    assert order == ["first_start", "first_end", "second_start", "second_end"]


@pytest.mark.asyncio
async def test_key_lock_runs_different_keys_at_once():
    lock = KeyLock()
    order: list[str] = []
    await asyncio.gather(
        _section(lock, "/a", "a", order),
        _section(lock, "/b", "b", order),
    )
    assert order.index("b_start") < order.index("a_end")


@pytest.mark.asyncio
async def test_key_lock_keeps_nothing_once_released():
    # An owner touching many paths over its life holds no lock for the
    # ones it is done with, whether the body returned or raised.
    lock = KeyLock()
    await asyncio.gather(
        _section(lock, "/a", "a", []), _section(lock, "/a", "b", [])
    )
    with pytest.raises(RuntimeError):
        async with lock.with_lock("/b"):
            raise RuntimeError("boom")
    async with lock.with_lock("/b"):
        pass
    assert lock._locks == {} and lock._users == {}
