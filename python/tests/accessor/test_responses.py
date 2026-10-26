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

from mirage.accessor.responses import ResponseCache
from mirage.types import ReadPolicy, ReadSpec


class _Service:
    def __init__(self) -> None:
        self.asked = 0

    async def answer(self) -> int:
        self.asked += 1
        return self.asked


@pytest.mark.asyncio
async def test_an_ungoverned_answer_is_kept_until_cleared():
    service, cache = _Service(), ResponseCache[str, int]()
    assert await cache.get("q", service.answer) == 1
    assert await cache.get("q", service.answer) == 1
    cache.clear()
    assert await cache.get("q", service.answer) == 2


@pytest.mark.asyncio
async def test_a_fresh_mount_keeps_nothing():
    service, cache = _Service(), ResponseCache[str, int]()
    cache.govern(ReadSpec(policy=ReadPolicy.FRESH))
    assert await cache.get("q", service.answer) == 1
    assert await cache.get("q", service.answer) == 2


@pytest.mark.asyncio
async def test_a_bounded_mount_keeps_an_answer_within_its_bound(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(
        "mirage.accessor.responses.time.monotonic", lambda: now[0]
    )
    service, cache = _Service(), ResponseCache[str, int]()
    cache.govern(ReadSpec(policy=ReadPolicy.BOUNDED, ttl=30))
    assert await cache.get("q", service.answer) == 1
    now[0] = 129.0
    assert await cache.get("q", service.answer) == 1
    now[0] = 130.0
    assert await cache.get("q", service.answer) == 2


@pytest.mark.asyncio
async def test_the_strictest_bound_wins(monkeypatch):
    # The client's own bound when it is shorter, and the shorter of two
    # mounts' bounds for a client mounted twice.
    now = [0.0]
    monkeypatch.setattr(
        "mirage.accessor.responses.time.monotonic", lambda: now[0]
    )
    service, cache = _Service(), ResponseCache[str, int](5)
    cache.govern(ReadSpec(policy=ReadPolicy.BOUNDED, ttl=600))
    cache.govern(ReadSpec(policy=ReadPolicy.BOUNDED, ttl=60))
    assert await cache.get("q", service.answer) == 1
    now[0] = 5.0
    assert await cache.get("q", service.answer) == 2


@pytest.mark.asyncio
async def test_an_answer_is_kept_from_when_it_arrives(monkeypatch):
    # A fetch slower than the bound is kept for the bound once it lands,
    # as the file cache keeps a read from when it lands.
    now = [0.0]
    monkeypatch.setattr(
        "mirage.accessor.responses.time.monotonic", lambda: now[0]
    )
    service, cache = _Service(), ResponseCache[str, int](1)

    async def slow() -> int:
        now[0] += 5.0
        return await service.answer()

    assert await cache.get("q", slow) == 1
    now[0] = 5.5
    assert await cache.get("q", slow) == 1
    now[0] = 6.0
    assert await cache.get("q", slow) == 2


@pytest.mark.asyncio
async def test_a_stricter_mount_drops_what_a_looser_one_kept():
    # Kept under a 600 s bound, an answer would outlive a 30 s one.
    service, cache = _Service(), ResponseCache[str, int]()
    cache.govern(ReadSpec(policy=ReadPolicy.BOUNDED, ttl=600))
    assert await cache.get("q", service.answer) == 1
    cache.govern(ReadSpec(policy=ReadPolicy.BOUNDED, ttl=30))
    assert await cache.get("q", service.answer) == 2


@pytest.mark.asyncio
async def test_an_answer_that_raced_a_clear_is_not_kept():
    # The clear may be for the very write the answer predates.
    cache = ResponseCache[str, str]()
    started, release = asyncio.Event(), asyncio.Event()

    async def slow() -> str:
        started.set()
        await release.wait()
        return "before"

    asking = asyncio.create_task(cache.get("q", slow))
    await started.wait()
    cache.clear()
    release.set()
    assert await asking == "before"

    async def after() -> str:
        return "after"

    assert await cache.get("q", after) == "after"
