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

from mirage.runtime.python.monty.execution import MontyExecution


@pytest.mark.asyncio
async def test_concurrent_first_use_shares_one_pool():
    execution = MontyExecution()
    try:
        pools = await asyncio.gather(
            *(execution._ensure_pool() for _ in range(3))
        )
        assert len({id(pool) for pool in pools}) == 1
    finally:
        await execution.close()


@pytest.mark.asyncio
async def test_close_waits_for_a_pool_still_being_opened(monkeypatch):
    execution = MontyExecution()
    opened = asyncio.get_running_loop().create_future()
    closed: list[bool] = []

    class Pool:
        async def __aexit__(self, *_: object) -> None:
            closed.append(True)

    async def open_pool() -> Pool:
        return await opened

    monkeypatch.setattr(execution, "_open_pool", open_pool)
    opening = asyncio.ensure_future(execution._ensure_pool())
    await asyncio.sleep(0)
    closing = asyncio.ensure_future(execution.close())
    opened.set_result(Pool())
    await asyncio.gather(opening, closing)
    assert closed == [True]
