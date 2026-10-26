import sys
import time

from mirage.io import yield_budget as budget_mod
from mirage.io.yield_budget import YieldBudget
from tests.fixtures.held_loop import HeldLoop, run_on_held_loop


def test_run_yields_only_after_budget_on_the_loop_clock():
    budget = budget_mod.YIELD_SWITCHES * sys.getswitchinterval()

    async def main(loop: HeldLoop) -> list[int]:
        point = YieldBudget()
        ran: list[int] = []
        await point.run()
        loop.call_soon(ran.append, 1)
        await point.run()
        assert ran == []

        loop.now += budget * 2

        def tick() -> None:
            ran.append(2)
            loop.now += 1.0

        loop.call_soon(tick)
        await point.run()
        assert ran == [1, 2]

        loop.call_soon(ran.append, 3)
        await point.run()
        return list(ran)

    assert run_on_held_loop(main) == [1, 2]


def test_real_time_alone_never_spends_the_budget():
    budget = budget_mod.YIELD_SWITCHES * sys.getswitchinterval()

    async def main(loop: HeldLoop) -> list[int]:
        point = YieldBudget()
        ran: list[int] = []
        await point.run()
        time.sleep(budget * 3)

        def tick() -> None:
            ran.append(1)
            loop.now += 1.0

        loop.call_soon(tick)
        await point.run()
        return list(ran)

    assert run_on_held_loop(main) == []


def test_a_budget_built_outside_a_loop_starts_at_its_first_run():
    point = YieldBudget()

    async def main(loop: HeldLoop) -> list[int]:
        ran: list[int] = []
        loop.call_soon(ran.append, 1)
        await point.run()
        return list(ran)

    assert run_on_held_loop(main) == []


async def spin_until_a_turn(loop: HeldLoop) -> list[int]:
    point = YieldBudget()
    ran: list[int] = []

    def tick() -> None:
        ran.append(calls)
        loop.now += 1e-3

    loop.call_soon(tick)
    calls = 0
    while not ran:
        calls += 1
        await point.run()
    return list(ran)


def test_a_busy_consumer_yields_on_a_held_clock_within_the_call_bound():
    # A loop that keeps virtual time holds it still while a task
    # computes; the call bound still hands timers and cancellation a turn.
    assert run_on_held_loop(spin_until_a_turn) == [budget_mod.YIELD_CALLS]
