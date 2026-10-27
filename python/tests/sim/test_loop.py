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
import random
import socket

import pytest

from tests.sim.loop import (
    SIM_EPOCH,
    Deadlock,
    SimClock,
    SimLoop,
    Stall,
    run,
)


async def _two_sleeps() -> tuple[float, float]:
    clock = SimClock(asyncio.get_running_loop())
    await asyncio.gather(clock.sleep(30), clock.sleep(30))
    return clock.monotonic(), clock.now()


def test_concurrent_sleeps_overlap():
    (elapsed, wall), _ = run(_two_sleeps())
    assert elapsed == 30
    assert wall == SIM_EPOCH + 30


async def _wait_for_past_its_deadline() -> float:
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(asyncio.sleep(3600), timeout=600)
    return asyncio.get_running_loop().time()


def test_wait_for_times_out_on_virtual_time():
    at, _ = run(_wait_for_past_its_deadline())
    assert at == 600


def test_a_blocking_job_runs_after_its_lag_in_order():
    order = []

    async def main():
        await asyncio.gather(
            asyncio.to_thread(order.append, "first"),
            asyncio.to_thread(order.append, "second"),
        )
        return asyncio.get_running_loop().time()

    at, _ = run(main(), lag=lambda nth: 5 - nth)
    assert order == ["second", "first"]
    assert at == 5


def test_a_job_cancelled_during_its_lag_never_runs():
    ran = []

    async def main():
        job = asyncio.ensure_future(asyncio.to_thread(ran.append, "job"))
        await asyncio.sleep(1)
        job.cancel()
        await asyncio.sleep(10)

    run(main(), lag=lambda nth: 5)
    assert ran == []


async def _recv_on_a_real_socket() -> None:
    left, right = socket.socketpair()
    left.setblocking(False)
    try:
        await asyncio.get_running_loop().sock_recv(left, 1)
    finally:
        left.close()
        right.close()


def test_a_real_socket_is_refused():
    with pytest.raises(RuntimeError, match="real I/O"):
        run(_recv_on_a_real_socket())


async def _stuck(gate: asyncio.Future[None]) -> None:
    await gate


async def _two_stuck_tasks() -> None:
    loop = asyncio.get_running_loop()
    gate = loop.create_future()
    await asyncio.gather(
        loop.create_task(_stuck(gate), name="stuck-a"),
        loop.create_task(_stuck(gate), name="stuck-b"),
    )


def test_a_deadlock_names_its_tasks():
    with pytest.raises(Deadlock) as caught:
        run(_two_stuck_tasks())
    names = [task.name for task in caught.value.tasks]
    assert "stuck-a" in names and "stuck-b" in names
    assert "test_loop.py" in str(caught.value) and "_stuck" in str(
        caught.value
    )


async def _spin() -> None:
    while True:
        await asyncio.sleep(0)


def test_a_task_spinning_on_zero_delay_yields_stalls():
    with pytest.raises(Stall, match="1000 loop turns") as caught:
        run(_spin(), max_turns=1000)
    assert "_spin" in str(caught.value)


async def _leave_a_task_behind() -> None:
    asyncio.get_running_loop().create_task(_spin(), name="orphan")


def test_a_task_outliving_the_program_is_an_error():
    with pytest.raises(RuntimeError, match="orphan"):
        run(_leave_a_task_behind())


async def _settle_then_wait():
    loop = asyncio.get_running_loop()
    assert isinstance(loop, SimLoop)
    steps = []

    async def chain():
        for i in range(50):
            steps.append(i)
            await asyncio.sleep(0)

    task = loop.create_task(chain())
    loop.call_later(60, steps.append, "timer")
    await loop.settle()
    settled = (loop.time(), list(steps), task.done())
    await asyncio.sleep(61)
    return settled, steps[-1]


def test_settle_runs_what_is_runnable_without_advancing_time():
    (settled, last), _ = run(_settle_then_wait())
    assert settled == (0, list(range(50)), True)
    assert last == "timer"


def _program(seed):
    events = []

    async def worker(name):
        rng = random.Random(f"{seed}:{name}")
        for step in range(20):
            await asyncio.sleep(rng.expovariate(200))
            if rng.random() < 0.3:
                await asyncio.to_thread(events.append, (name, step, "job"))
            events.append((asyncio.get_running_loop().time(), name, step))

    async def main():
        await asyncio.gather(*(worker(n) for n in "abcd"))

    _, loop = run(main(), lag=lambda nth: (nth * 7919 % 13) / 1000)
    return events, loop.time(), loop.timeline.turns


def test_one_program_replays_identically():
    first = _program(7)
    assert first == _program(7)
    assert first != _program(8)


async def _crash() -> None:
    raise ValueError("worker crashed")


async def _start_a_worker_that_crashes() -> None:
    asyncio.get_running_loop().create_task(_crash())
    await asyncio.sleep(1)


def test_a_task_that_fails_unobserved_fails_the_run():
    with pytest.raises(ExceptionGroup) as caught:
        run(_start_a_worker_that_crashes())
    assert caught.group_contains(ValueError, match="worker crashed")


async def _recv_with_data_waiting() -> None:
    left, right = socket.socketpair()
    left.setblocking(False)
    right.sendall(b"ready")
    try:
        await asyncio.get_running_loop().sock_recv(left, 5)
    finally:
        left.close()
        right.close()


async def _resolve_a_host() -> None:
    await asyncio.get_running_loop().getaddrinfo("localhost", 80)


@pytest.mark.parametrize("program", [_recv_with_data_waiting, _resolve_a_host])
def test_real_io_is_refused_even_when_it_would_not_wait(program):
    with pytest.raises(RuntimeError, match="real I/O"):
        run(program())


async def _a_callback_reads_a_cancelled_future() -> None:
    loop = asyncio.get_running_loop()
    cancelled = loop.create_future()
    cancelled.cancel()
    loop.call_soon(cancelled.result)
    await asyncio.sleep(1)


def test_a_callback_that_raises_cancelled_still_fails_the_run():
    with pytest.raises(BaseExceptionGroup) as caught:
        run(_a_callback_reads_a_cancelled_future())
    assert caught.group_contains(asyncio.CancelledError)
