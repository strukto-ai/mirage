import asyncio
from types import SimpleNamespace

import pytest

from mirage.io import yield_budget as budget_mod
from mirage.io.yield_budget import YieldBudget


@pytest.mark.asyncio
async def test_run_yields_only_after_budget(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(budget_mod, "time",
                        SimpleNamespace(monotonic=lambda: clock[0]))
    point = YieldBudget()
    ran: list[int] = []
    asyncio.get_running_loop().call_soon(ran.append, 1)

    await point.run()
    assert ran == []

    clock[0] += budget_mod.YIELD_INTERVAL * 2
    await point.run()
    assert ran == [1]

    asyncio.get_running_loop().call_soon(ran.append, 2)
    await point.run()
    assert ran == [1]
