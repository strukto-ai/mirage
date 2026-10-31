import asyncio
import gc
import inspect
import subprocess
import sys
import threading
from contextvars import ContextVar

import pytest

from mirage.bridge.sync import (
    BLOCKED,
    SyncBridge,
    blocking,
    handed,
    on_auxiliary_loop,
    run_async_from_sync,
    soon,
)
from mirage.core.api.client import SessionPool

SHUTDOWN_REPRO = """
import asyncio
import concurrent.futures
import threading

from mirage import RAMVFS, Workspace

ws = Workspace({"/": RAMVFS()})

async def seed():
    return await ws.shell("echo seed")

ws._run_sync(seed, "seed")
owner = ws._sync_bridge._loop
admitted, submit = threading.Event(), threading.Event()
submitted = threading.Event()
cleanup_entered, cleanup_release = threading.Event(), threading.Event()
original_submit = asyncio.run_coroutine_threadsafe
original_shutdown = owner.shutdown_default_executor

def gated_submit(pending, loop):
    if threading.current_thread().name == "tool-caller":
        admitted.set()
        assert submit.wait(3)
        try:
            return original_submit(pending, loop)
        finally:
            submitted.set()
    return original_submit(pending, loop)

async def shutdown_executor(*args, **kwargs):
    await original_shutdown(*args, **kwargs)
    cleanup_entered.set()
    assert cleanup_release.wait(3)

asyncio.run_coroutine_threadsafe = gated_submit
owner.shutdown_default_executor = shutdown_executor
result, close_result = concurrent.futures.Future(), concurrent.futures.Future()

async def tool():
    return await ws.shell("echo late")

def call():
    try:
        result.set_result(ws._run_sync(tool, "tool"))
    except BaseException as exc:
        result.set_exception(exc)

def close():
    try:
        close_result.set_result(asyncio.run(ws.close()))
    except BaseException as exc:
        close_result.set_exception(exc)

caller = threading.Thread(target=call, name="tool-caller", daemon=True)
closer = threading.Thread(target=close, daemon=True)
caller.start()
assert admitted.wait(3)
closer.start()
cleanup_entered.wait(.2)
submit.set()
assert submitted.wait(3)
assert cleanup_entered.wait(3)
cleanup_release.set()
close_result.result(timeout=3)
try:
    result.result(timeout=3)
except (RuntimeError, concurrent.futures.CancelledError):
    pass
assert owner.is_closed()
caller.join(timeout=3)
closer.join(timeout=3)
assert not caller.is_alive() and not closer.is_alive()
"""

CANCEL_BEFORE_START_REPRO = """
import asyncio
import threading

from mirage.bridge.sync import SyncBridge

bridge = SyncBridge()
entered, release = threading.Event(), threading.Event()
made = []

async def value():
    made.append(True)
    return 7

bridge.run(value, "value")
made.clear()
owner = bridge._loop

def block_owner():
    entered.set()
    assert release.wait(3)

owner.call_soon_threadsafe(block_owner)
assert entered.wait(3)

async def main():
    task = asyncio.create_task(bridge.arun(value))
    await asyncio.sleep(0)
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()
    release.set()
    try:
        await asyncio.wait_for(task, 3)
    except asyncio.CancelledError:
        pass
    else:
        raise AssertionError("cancellation was lost")
    assert not made, "cancelled queued callback was invoked"

try:
    asyncio.run(main())
finally:
    release.set()
    bridge.shutdown()
"""


def test_cross_loop_cancellation_before_start_in_bounded_process():
    result = subprocess.run(
        [
            sys.executable,
            "-Werror::RuntimeWarning",
            "-c",
            CANCEL_BEFORE_START_REPRO,
        ],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "Task was destroyed" not in result.stderr
    assert "never awaited" not in result.stderr


def test_submission_racing_shutdown_in_bounded_process():
    result = subprocess.run(
        [sys.executable, "-Werror::RuntimeWarning", "-c", SHUTDOWN_REPRO],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "Task was destroyed" not in result.stderr
    assert "never awaited" not in result.stderr


async def value() -> int:
    return 7


async def fail_with_runtime_error() -> int:
    raise RuntimeError("operation failed")


def test_run_async_from_sync_without_running_loop():
    assert run_async_from_sync(value()) == 7


@pytest.mark.asyncio
async def test_run_async_from_sync_inside_running_loop():
    assert run_async_from_sync(value()) == 7


@pytest.mark.asyncio
async def test_run_async_from_sync_with_current_loop_does_not_deadlock():
    assert run_async_from_sync(value(), asyncio.get_running_loop()) == 7


@pytest.mark.asyncio
@pytest.mark.parametrize("explicit_loop", [False, True])
async def test_temporary_loop_reads_do_not_invalidate_foreground_owner(
    explicit_loop,
):
    bridge = SyncBridge()
    owner = asyncio.get_running_loop()
    bridge.observe()

    async def read():
        bridge.observe()
        bridge.attach()
        return asyncio.get_running_loop()

    assert (
        run_async_from_sync(read(), owner if explicit_loop else None)
        is not owner
    )
    assert bridge._loop is owner
    assert not bridge._ambiguous
    assert await asyncio.to_thread(bridge.run, value, "value") == 7


def test_temporary_loop_read_does_not_claim_a_foreground_owner():
    bridge = SyncBridge()

    async def read():
        bridge.observe()
        bridge.attach()
        return 7

    assert run_async_from_sync(read()) == 7
    assert bridge._loop is None


@pytest.mark.asyncio
async def test_adapter_bridge_rejects_owner_without_constructing_coroutine():
    bridge = SyncBridge()
    bridge.observe()
    made = []

    def factory():
        made.append(True)
        return value()

    with pytest.raises(RuntimeError, match="await value"):
        bridge.run(factory, "value")
    assert made == []


@pytest.mark.asyncio
async def test_runtime_error_from_operation_propagates_unchanged():
    with pytest.raises(RuntimeError, match="operation failed"):
        run_async_from_sync(fail_with_runtime_error())


def test_closed_owner_closes_rejected_coroutine():
    loop = asyncio.new_event_loop()
    loop.close()
    pending = value()
    with pytest.raises(RuntimeError, match="owner event loop is closed"):
        run_async_from_sync(pending, loop)
    assert inspect.getcoroutinestate(pending) == inspect.CORO_CLOSED


@pytest.mark.asyncio
async def test_auxiliary_callback_does_not_claim_owner_and_restores_context():
    bridge = SyncBridge()

    async def callback():
        bridge.observe()
        bridge.attach()
        assert bridge._loop is None
        raise ValueError("callback failed")

    with pytest.raises(ValueError, match="callback failed"):
        await on_auxiliary_loop(callback)
    bridge.observe()
    assert bridge._loop is asyncio.get_running_loop()


def test_closed_auxiliary_loop_does_not_construct_its_callback():
    loop = asyncio.new_event_loop()
    loop.close()
    made = []

    def factory():
        made.append(True)
        return value()

    pending = on_auxiliary_loop(factory)
    with pytest.raises(RuntimeError, match="owner event loop is closed"):
        run_async_from_sync(pending, loop)
    assert made == []
    assert inspect.getcoroutinestate(pending) == inspect.CORO_CLOSED


def test_sync_bridge_reuses_pool_and_closes_on_its_owner():
    bridge = SyncBridge()
    pool = SessionPool()

    async def get():
        return asyncio.get_running_loop(), pool.get()

    try:
        loop, session = bridge.run(get, "get")
        assert bridge.run(get, "get") == (loop, session)
        asyncio.run(bridge.close(pool.close))
        assert session.closed
    finally:
        bridge.shutdown()
    assert loop.is_closed()
    with pytest.raises(RuntimeError, match="not running"):
        bridge.run(get, "get")


@pytest.mark.asyncio
async def test_worker_preserves_context_and_does_not_close_borrowed_loop():
    bridge = SyncBridge()
    bridge.observe()
    owner = asyncio.get_running_loop()
    context = ContextVar("adapter-test", default="missing")

    async def get():
        return asyncio.get_running_loop(), context.get()

    token = context.set("caller")
    try:
        assert await asyncio.to_thread(bridge.run, get, "get") == (
            owner,
            "caller",
        )
        await bridge.ashutdown()
        assert owner.is_running()
    finally:
        context.reset(token)


def test_observing_multiple_loops_refuses_without_constructing_coroutine():
    bridge = SyncBridge()
    first, second = asyncio.new_event_loop(), asyncio.new_event_loop()
    try:
        bridge.observe(first)
        bridge.observe(second)
        with pytest.raises(RuntimeError, match="multiple event loops"):
            bridge.run(value, "value")
    finally:
        first.close()
        second.close()


def test_cancelled_close_finishes_before_the_owned_loop_stops():
    bridge = SyncBridge()
    bridge.run(value, "value")
    owner = bridge._loop
    entered = threading.Event()
    release = asyncio.Event()
    finished = threading.Event()

    async def close():
        entered.set()
        await release.wait()
        finished.set()

    async def caller():
        closing = asyncio.create_task(bridge.close(close))
        assert await asyncio.to_thread(entered.wait, 2)
        closing.cancel()
        await asyncio.sleep(0)
        assert not closing.done()
        owner.call_soon_threadsafe(release.set)
        with pytest.raises(asyncio.CancelledError):
            await closing
        assert finished.is_set()

    try:
        asyncio.run(caller())
    finally:
        bridge.shutdown()


@pytest.mark.asyncio
async def test_blocking_marks_the_running_loop_for_its_call():
    loop = asyncio.get_running_loop()
    with blocking():
        with blocking():
            assert loop in BLOCKED
        assert loop in BLOCKED
    assert loop not in BLOCKED


async def _nothing() -> None:
    return None


def test_a_collection_neither_drives_nor_waits_on_a_loop():
    loop = asyncio.new_event_loop()
    refused = []

    def during(phase, info):
        if phase == "start" and not refused:
            with pytest.raises(RuntimeError, match="garbage collection"):
                run_async_from_sync(_nothing(), loop)
            refused.append(loop.is_running())

    gc.callbacks.append(during)
    try:
        gc.collect()
    finally:
        gc.callbacks.remove(during)
        loop.close()
    assert refused == [False]


def test_handed_work_starts_before_a_later_call():
    loop = asyncio.new_event_loop()
    events = []

    async def record(name: str) -> None:
        events.append(name)

    try:
        soon(loop, record("handed"))
        run_async_from_sync(record("later"), loop)
    finally:
        loop.close()
    assert events == ["handed", "later"]


def test_handed_waits_for_work_handed_to_its_loop():
    loop = asyncio.new_event_loop()
    events = []

    async def slow() -> None:
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        events.append("done")

    try:
        soon(loop, slow())
        loop.run_until_complete(handed())
    finally:
        loop.close()
    assert events == ["done"]


def test_work_handed_to_a_closed_loop_is_dropped():
    loop = asyncio.new_event_loop()
    loop.close()
    work = _nothing()
    soon(loop, work)
    assert inspect.getcoroutinestate(work) == inspect.CORO_CLOSED


class _HandsOff:
    """Hands work to a running loop from its finalizer, in a cycle of its
    own, and notes whether the loop ran it before the collection ended."""

    def __init__(self, loop, events) -> None:
        self.loop = loop
        self.events = events
        self.cycle = self

    def __del__(self) -> None:
        async def record() -> None:
            self.events.append("ran")

        soon(self.loop, record())
        threading.Event().wait(0.05)
        self.events.append("collection ending")


def test_work_handed_off_in_a_collection_waits_for_it_to_end():
    loop = asyncio.new_event_loop()
    ready = threading.Event()
    loop.call_soon(ready.set)
    owner = threading.Thread(target=loop.run_forever, daemon=True)
    owner.start()
    assert ready.wait(5)
    events = []
    enabled = gc.isenabled()
    gc.disable()
    try:
        _HandsOff(loop, events)
        gc.collect()
    finally:
        if enabled:
            gc.enable()
    asyncio.run_coroutine_threadsafe(handed(), loop).result(5)
    loop.call_soon_threadsafe(loop.stop)
    owner.join(5)
    loop.close()
    assert events == ["collection ending", "ran"]
