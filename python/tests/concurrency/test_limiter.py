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
import contextvars
import sys
import threading
from dataclasses import dataclass
from typing import Any

import pytest
from opentelemetry import context as otel_context
from opentelemetry import trace

from mirage.concurrency import ConcurrencyLimiter
from mirage.concurrency.limiter import (
    FirstDone,
    bounded_map,
    bounded_map_stream,
    on_loop,
    owned_task,
    run_blocking,
    settle,
    shallow,
)

_SEEN: contextvars.ContextVar[str] = contextvars.ContextVar("_SEEN")


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


async def _mark() -> asyncio.Task[Any] | None:
    _SEEN.set("set by the work")
    return asyncio.current_task()


async def _at_depth(levels: int) -> asyncio.Task[Any] | None:
    if levels:
        return await _at_depth(levels - 1)
    return await shallow(_mark())


@pytest.mark.asyncio
async def test_shallow_moves_deep_work_to_a_task_in_the_same_context():
    here = asyncio.current_task()
    assert await _at_depth(0) is here
    _SEEN.set("")
    assert await _at_depth(sys.getrecursionlimit() // 2) is not here
    assert _SEEN.get() == "set by the work"


@pytest.mark.asyncio
async def test_shallow_starts_from_the_loop_under_an_eager_task_factory():
    loop = asyncio.get_running_loop()
    loop.set_task_factory(asyncio.eager_task_factory)
    try:
        _SEEN.set("")
        deep = await _at_depth(sys.getrecursionlimit() // 2)
    finally:
        loop.set_task_factory(None)
    assert deep is not asyncio.current_task()
    assert _SEEN.get() == "set by the work"


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


async def _running_loop() -> asyncio.AbstractEventLoop:
    return asyncio.get_running_loop()


async def _current_span_context() -> trace.SpanContext:
    return trace.get_current_span().get_span_context()


# Work handed to another loop runs there; a caller that is cancelled
# cancels it there and returns only once it has settled.
@pytest.mark.asyncio
async def test_on_loop_runs_the_work_there_and_cancels_it_there():
    other = asyncio.new_event_loop()
    thread = threading.Thread(target=other.run_forever, daemon=True)
    thread.start()
    started, settled = threading.Event(), threading.Event()

    async def held() -> None:
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            settled.set()

    try:
        here = asyncio.get_running_loop()
        assert await on_loop(_running_loop(), other) is other
        assert await on_loop(_running_loop(), here) is here
        call = asyncio.create_task(on_loop(held(), other))
        assert await asyncio.to_thread(started.wait, 5)
        call.cancel()
        with pytest.raises(asyncio.CancelledError):
            await call
        assert settled.is_set()
    finally:
        other.call_soon_threadsafe(other.stop)
        await asyncio.to_thread(thread.join, 5)
        other.close()


# Work handed to another loop runs under a copy of the caller's context,
# so a span it opens there joins the caller's trace: a hosted line's
# command span relies on it.
@pytest.mark.asyncio
async def test_on_loop_carries_the_callers_trace_context():
    other = asyncio.new_event_loop()
    thread = threading.Thread(target=other.run_forever, daemon=True)
    thread.start()
    caller = trace.SpanContext(
        trace_id=0x4BF92F3577B34DA6A3CE929D0E0E4736,
        span_id=0x00F067AA0BA902B7,
        is_remote=True,
        trace_flags=trace.TraceFlags(trace.TraceFlags.SAMPLED),
    )

    token = otel_context.attach(
        trace.set_span_in_context(trace.NonRecordingSpan(caller))
    )
    try:
        assert await on_loop(_current_span_context(), other) == caller
    finally:
        otel_context.detach(token)
        other.call_soon_threadsafe(other.stop)
        await asyncio.to_thread(thread.join, 5)
        other.close()


def _turns(counted: dict[str, int], waits: int) -> list[int]:
    """A count the running loop adds one to each turn, until ``waits``
    waiters have written into ``counted``."""
    loop = asyncio.get_running_loop()
    turns = [0]

    def turn() -> None:
        turns[0] += 1
        if len(counted) < waits:
            loop.call_soon(turn)

    turn()
    return turns


# A wait on a line or on a forked child is made on every line, so a turn
# of the loop it costs is a slice of whatever else runs there. The wait
# wakes on the turn a plain await of the future wakes on: both are woken
# by the future's own callbacks, one after the other.
@pytest.mark.asyncio
async def test_first_done_wakes_on_the_turn_an_await_of_the_future_does():
    release = asyncio.Event()
    woke: dict[str, int] = {}
    work = asyncio.ensure_future(release.wait())

    async def first() -> None:
        await FirstDone([work])
        woke["first"] = turns[0]

    async def plain() -> None:
        await work
        woke["plain"] = turns[0]

    waiters = [asyncio.create_task(first()), asyncio.create_task(plain())]
    turns = _turns(woke, 2)
    await asyncio.sleep(0)
    release.set()
    await asyncio.gather(*waiters)
    assert woke["first"] == woke["plain"]
    assert work.result() is True


@pytest.mark.asyncio
async def test_first_done_wakes_for_the_first_and_leaves_the_rest_running():
    events = [asyncio.Event() for _ in range(3)]
    waits = [asyncio.ensure_future(event.wait()) for event in events]
    waiter = asyncio.ensure_future(_first_done(waits))
    await asyncio.sleep(0)
    assert not waiter.done()
    events[1].set()
    await waiter
    assert [wait.done() for wait in waits] == [False, True, False]
    assert await _first_done(waits) is None
    for wait in waits:
        wait.cancel()


async def _first_done(futures: list[asyncio.Future[Any]]) -> None:
    await FirstDone(futures)


# A cancelled waiter leaves the wait on the loop's next turn and what it
# waited for runs on, as behind asyncio.shield; a second cancel changes
# nothing. One cancelled as a future ends is woken by that end, and
# cancelled there, with the future's own result untouched.
@pytest.mark.asyncio
async def test_a_cancelled_first_done_leaves_its_futures_running():
    release = asyncio.Event()
    work = asyncio.ensure_future(release.wait())
    waiter = asyncio.ensure_future(_first_done([work]))
    other = asyncio.ensure_future(_first_done([work]))
    await asyncio.sleep(0)
    waiter.cancel()
    waiter.cancel()
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert waiter.cancelled()
    assert not work.done() and not other.done()
    ending = asyncio.ensure_future(release.wait())
    await asyncio.sleep(0)
    ending.add_done_callback(lambda _future: late.cancel())
    late = asyncio.ensure_future(_first_done([ending]))
    await asyncio.sleep(0)
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await late
    assert ending.result() is True
    await other
    assert work.result() is True


# A cancel's message reaches the waiter's CancelledError, as it does
# behind asyncio.shield, so a caller that logs why a line stopped still
# reads it.
@pytest.mark.asyncio
@pytest.mark.parametrize("message", [None, "the caller went away"])
async def test_a_cancelled_first_done_carries_the_cancels_message(message):
    async def args_of(wait: Any) -> tuple[Any, ...]:
        try:
            await wait
        except asyncio.CancelledError as exc:
            return exc.args
        return ("not cancelled",)

    release = asyncio.Event()
    work = asyncio.ensure_future(release.wait())
    waiters = [
        asyncio.ensure_future(args_of(FirstDone([work]))),
        asyncio.ensure_future(args_of(asyncio.shield(work))),
    ]
    await asyncio.sleep(0)
    for waiter in waiters:
        waiter.cancel(message)
    first, shielded = await asyncio.gather(*waiters)
    assert first == shielded == (() if message is None else (message,))
    assert not work.done()
    release.set()
    assert await work is True
