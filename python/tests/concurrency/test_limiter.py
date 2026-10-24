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
import sys
import threading
from dataclasses import dataclass

import pytest

from mirage.concurrency import ConcurrencyLimiter
from mirage.concurrency.limiter import (
    bounded_map,
    bounded_map_stream,
    owned_task,
    run_blocking,
    settle,
)


@dataclass
class _ConcurrencyState:
    active: int = 0
    peak: int = 0


@pytest.mark.asyncio
async def test_blocking_work_keeps_loop_live_and_retains_ownership_on_cancel():
    loop = asyncio.get_running_loop()
    entered, release = asyncio.Event(), threading.Event()
    finished = []

    def work():
        loop.call_soon_threadsafe(entered.set)
        assert release.wait(2)
        finished.append(True)

    task = asyncio.create_task(run_blocking(work))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert finished == [True]
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)


async def _hold_permit(
    limiter: ConcurrencyLimiter,
    state: _ConcurrencyState,
    entered: asyncio.Queue[None],
    release: asyncio.Event,
) -> None:
    async with limiter.acquire():
        state.active += 1
        state.peak = max(state.peak, state.active)
        entered.put_nowait(None)
        try:
            await release.wait()
        finally:
            state.active -= 1


async def _acquire_once(limiter: ConcurrencyLimiter) -> None:
    async with limiter.acquire():
        return


@pytest.mark.parametrize("max_concurrency", [0, -1])
def test_rejects_non_positive_capacity(max_concurrency: int) -> None:
    with pytest.raises(ValueError, match="at least 1"):
        ConcurrencyLimiter(max_concurrency)


@pytest.mark.asyncio
async def test_limits_concurrent_operations() -> None:
    limiter = ConcurrencyLimiter(2)
    state = _ConcurrencyState()
    entered: asyncio.Queue[None] = asyncio.Queue()
    release = asyncio.Event()
    tasks = [
        asyncio.create_task(_hold_permit(limiter, state, entered, release))
        for _ in range(5)
    ]

    await entered.get()
    await entered.get()
    await asyncio.sleep(0)
    assert entered.empty()

    release.set()
    await asyncio.gather(*tasks)
    assert state.peak == 2


@pytest.mark.asyncio
async def test_exception_releases_capacity() -> None:
    limiter = ConcurrencyLimiter(1)

    with pytest.raises(RuntimeError, match="boom"):
        async with limiter.acquire():
            raise RuntimeError("boom")

    await asyncio.wait_for(_acquire_once(limiter), timeout=0.1)


@pytest.mark.asyncio
async def test_cancellation_releases_capacity() -> None:
    limiter = ConcurrencyLimiter(1)
    state = _ConcurrencyState()
    entered: asyncio.Queue[None] = asyncio.Queue()
    release = asyncio.Event()
    task = asyncio.create_task(_hold_permit(limiter, state, entered, release))
    await entered.get()

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    await asyncio.wait_for(_acquire_once(limiter), timeout=0.1)


@pytest.mark.asyncio
async def test_cancellation_during_handoff_returns_permit_to_next_waiter():
    limiter = ConcurrencyLimiter(1)
    async with limiter.acquire():
        abandoned = asyncio.create_task(_acquire_once(limiter))
        following = asyncio.create_task(_acquire_once(limiter))
        await asyncio.sleep(0)
    abandoned.cancel()
    with pytest.raises(asyncio.CancelledError):
        await abandoned
    await asyncio.wait_for(following, 1)
    await asyncio.wait_for(_acquire_once(limiter), 1)


async def _answer() -> int:
    return 3


@pytest.mark.asyncio
@pytest.mark.skipif(
    sys.version_info < (3, 12), reason="eager tasks start in Python 3.12"
)
async def test_owned_work_that_never_waits_is_done_when_started() -> None:
    # Settling it then takes no turn of the loop, which a close on every
    # line would otherwise cost whatever else runs there.
    task = owned_task(_answer())
    assert task.done()
    assert await settle(task) == 3


@pytest.mark.asyncio
async def test_owned_work_that_waits_goes_on_as_a_task() -> None:
    release = asyncio.Event()
    task = owned_task(release.wait())
    assert not task.done()
    release.set()
    assert await settle(task) is True


@pytest.mark.asyncio
async def test_bounded_map_keeps_order_and_owns_its_workers():
    entered = asyncio.Event()
    cleaned = asyncio.Event()
    admitted = []

    async def one(value):
        admitted.append(value)
        if value == 0:
            await entered.wait()
            raise ValueError("download failed")
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleaned.set()

    with pytest.raises(ValueError, match="download failed"):
        await bounded_map(list(range(1000)), one, 2)
    assert admitted == [0, 1]
    assert cleaned.is_set()

    entered.clear()
    cleaned.clear()
    task = asyncio.create_task(bounded_map([1, 2, 3], one, 1))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert cleaned.is_set()

    async def double(value):
        await asyncio.sleep(0)
        return value * 2

    assert await bounded_map([3, 1, 2], double, 2) == [6, 2, 4]


@pytest.mark.asyncio
async def test_stream_map_yields_without_waiting_for_another_input_and_joins():
    closed = asyncio.Event()

    async def inputs():
        try:
            yield 1
            await asyncio.Event().wait()
        finally:
            closed.set()

    async def work(value):
        return value + 1

    mapped = bounded_map_stream(inputs(), work, 2)
    assert await asyncio.wait_for(anext(mapped), 1) == 2
    await mapped.aclose()
    assert closed.is_set()
