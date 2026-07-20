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
from dataclasses import dataclass

import pytest

from mirage.concurrency import ConcurrencyLimiter


@dataclass
class _ConcurrencyState:
    active: int = 0
    peak: int = 0


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
