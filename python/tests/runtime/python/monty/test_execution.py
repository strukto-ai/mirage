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
from mirage.runtime.python.monty.fs import MontyFs
from mirage.runtime.types import Program


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
        async def __aexit__(self, *exc) -> None:
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


@pytest.mark.asyncio
async def test_a_pool_that_failed_to_open_neither_sticks_nor_breaks_close(
    monkeypatch,
):
    execution = MontyExecution()
    attempts: list[int] = []

    async def open_pool() -> None:
        attempts.append(1)
        raise RuntimeError("monty is not installed")

    monkeypatch.setattr(execution, "_open_pool", open_pool)
    for _ in range(2):
        with pytest.raises(RuntimeError, match="not installed"):
            await execution._ensure_pool()
    await execution.close()
    assert len(attempts) == 2


@pytest.mark.asyncio
async def test_close_survives_a_pool_that_fails_while_it_waits(monkeypatch):
    execution = MontyExecution()
    opened = asyncio.get_running_loop().create_future()

    async def open_pool() -> None:
        await opened
        raise RuntimeError("monty is not installed")

    monkeypatch.setattr(execution, "_open_pool", open_pool)
    opening = asyncio.ensure_future(execution._ensure_pool())
    await asyncio.sleep(0)
    closing = asyncio.ensure_future(execution.close())
    opened.set_result(None)
    with pytest.raises(RuntimeError, match="not installed"):
        await opening
    await closing


# A sink that has not taken a print yet holds the program back, as a
# full pipe would: the program asks nothing more of the host until then.
class _Asking(MontyFs):
    def __init__(self) -> None:
        super().__init__(None, {})
        self.asked: list[str] = []

    def getenv(self, key: str, default: str | None = None) -> str | None:
        self.asked.append(key)
        return super().getenv(key, default)


@pytest.mark.asyncio
async def test_a_sink_that_waits_holds_the_program_back():
    execution = MontyExecution()
    fs = _Asking()
    taken: list[bytes] = []
    gate = asyncio.Event()

    async def output(data: bytes) -> None:
        taken.append(data)
        await gate.wait()

    code = "import os\nprint(1)\nos.getenv('X')\nprint(2)\n"
    try:
        run = asyncio.ensure_future(
            execution.run(Program(code=code), None, fs, output)
        )
        while not taken:
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.3)
        assert fs.asked == []
        gate.set()
        result = await asyncio.wait_for(run, 30)
        assert result.exit_code == 0
        assert fs.asked == ["X"]
        assert b"".join(taken) == b"1\n2\n"
    finally:
        await execution.close()


# A run cancelled while its sink holds a print cancels that write and
# waits for it, so neither the write nor Monty's callback outlives the run.
@pytest.mark.asyncio
async def test_a_cancelled_run_cancels_the_write_its_sink_holds():
    execution = MontyExecution()
    entered, cancelled = asyncio.Event(), asyncio.Event()

    async def output(data: bytes) -> None:
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            await asyncio.sleep(0.1)
            cancelled.set()
            raise

    try:
        run = asyncio.ensure_future(
            execution.run(
                Program(code="print(1)\n"), None, MontyFs(None, {}), output
            )
        )
        await entered.wait()
        run.cancel()
        with pytest.raises(asyncio.CancelledError):
            await run
        assert cancelled.is_set()
    finally:
        await execution.close()
