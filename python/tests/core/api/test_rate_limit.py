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

from mirage.core.api.rate_limit import RateLimiter
from mirage.utils.clock import ManualClock, SystemClock


class _Clock:
    def __init__(self) -> None:
        self.wall = 100.0
        self.waits: list[float] = []

    def now(self) -> float:
        return self.wall

    def monotonic(self) -> float:
        return self.wall

    async def sleep(self, seconds: float) -> None:
        self.waits.append(seconds)


class _Yielding(_Clock):
    async def sleep(self, seconds: float) -> None:
        self.waits.append(seconds)
        await asyncio.sleep(0)


class _Stalled(_Clock):
    def __init__(self, until: float) -> None:
        super().__init__()
        self.until = until

    async def sleep(self, seconds: float) -> None:
        start = self.wall
        self.waits.append(seconds)
        await asyncio.sleep(0)
        self.wall = max(self.wall, start + seconds, self.until)


def _limiter(rate: float, clock: _Clock) -> RateLimiter:
    return RateLimiter(rate, clock=clock)


@pytest.mark.asyncio
async def test_calls_sharing_a_key_are_spaced_by_the_rate():
    clock = _Clock()
    limiter = _limiter(5, clock)
    for _ in range(4):
        await limiter.acquire("appA")
    # the first call goes at once; each later one waits for its own slot
    assert clock.waits == pytest.approx([0.2, 0.4, 0.6])


@pytest.mark.asyncio
async def test_keys_are_paced_independently():
    clock = _Clock()
    limiter = _limiter(5, clock)
    await limiter.acquire("appA")
    await limiter.acquire("appB")
    assert clock.waits == []


@pytest.mark.asyncio
async def test_a_slot_already_past_costs_no_wait():
    clock = _Clock()
    limiter = _limiter(5, clock)
    await limiter.acquire("appA")
    clock.wall += 1.0
    await limiter.acquire("appA")
    assert clock.waits == []


@pytest.mark.asyncio
async def test_concurrent_callers_reserve_slots_in_arrival_order():
    clock = _Clock()
    limiter = _limiter(10, clock)
    await asyncio.gather(*(limiter.acquire("appA") for _ in range(3)))
    assert sorted(clock.waits) == pytest.approx([0.1, 0.2])


@pytest.mark.asyncio
async def test_a_late_wake_moves_the_slots_behind_it():
    clock = _Stalled(until=100.5)
    limiter = _limiter(5, clock)
    starts: list[float] = []

    async def call() -> None:
        await limiter.acquire("appA")
        starts.append(clock.wall)

    await asyncio.gather(call(), call(), call())
    await call()
    # the loop was blocked until 100.5, so the second and third callers
    # wake together; the third still goes a full interval after the second
    assert starts == pytest.approx([100.0, 100.5, 100.7, 100.9])


def test_a_rate_must_be_positive():
    with pytest.raises(ValueError):
        RateLimiter(0)


@pytest.mark.asyncio
async def test_a_bound_clock_paces_and_waits_on_its_own_time():
    limiter = RateLimiter(5)
    clock = ManualClock()
    limiter.bind_clock(clock, "ws")
    await limiter.acquire("appA")
    await limiter.acquire("appA")
    assert clock.monotonic() == pytest.approx(0.2)


@pytest.mark.asyncio
async def test_rebinding_the_clock_in_use_keeps_the_schedule():
    clock = _Clock()
    limiter = _limiter(5, clock)
    await limiter.acquire("appA")
    limiter.bind_clock(clock, "ws")
    await limiter.acquire("appA")
    assert clock.waits == pytest.approx([0.2])


@pytest.mark.asyncio
async def test_a_new_clock_under_a_waiting_caller_lets_it_finish():
    clock = _Stalled(until=0.0)
    limiter = _limiter(5, clock)
    await limiter.acquire("appA")
    waiting = asyncio.create_task(limiter.acquire("appA"))
    await asyncio.sleep(0)
    later = _Clock()
    later.wall = 200.0
    limiter.bind_clock(later, "ws")
    await waiting
    assert clock.waits == pytest.approx([0.2])


@pytest.mark.asyncio
async def test_a_caller_from_the_old_clock_leaves_the_new_schedule_alone():
    clock = _Stalled(until=0.0)
    limiter = _limiter(5, clock)
    await limiter.acquire("appA")
    waiting = asyncio.create_task(limiter.acquire("appA"))
    await asyncio.sleep(0)
    later = _Clock()
    later.wall = 200.0
    limiter.bind_clock(later, "ws")
    await limiter.acquire("appA")
    await waiting
    await limiter.acquire("appA")
    assert later.waits == pytest.approx([0.2])


@pytest.mark.asyncio
async def test_a_caller_from_before_a_round_trip_leaves_the_schedule_alone():
    clock = _Yielding()
    limiter = _limiter(5, clock)
    await limiter.acquire("appA")
    stale = asyncio.create_task(limiter.acquire("appA"))
    await asyncio.sleep(0)
    limiter.bind_clock(_Clock(), "ws")
    limiter.bind_clock(clock, "ws")
    clock.wall = 101.0
    await limiter.acquire("appA")
    fresh = asyncio.create_task(limiter.acquire("appA"))
    await asyncio.gather(stale, fresh)
    assert clock.waits == pytest.approx([0.2, 0.2])


def test_a_held_limiter_refuses_another_clock_until_its_owner_lets_go():
    limiter = RateLimiter(5)
    first, second = ManualClock(), ManualClock()
    limiter.bind_clock(first, "a")
    with pytest.raises(ValueError, match="another clock"):
        limiter.bind_clock(second, "b")
    limiter.release_clock("a")
    limiter.bind_clock(second, "b")


def test_two_system_clocks_agree_while_held():
    limiter = RateLimiter(5)
    limiter.bind_clock(SystemClock(), "a")
    limiter.bind_clock(SystemClock(), "b")
    with pytest.raises(ValueError):
        limiter.bind_clock(ManualClock(), "c")
