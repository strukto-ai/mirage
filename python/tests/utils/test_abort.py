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
import gc
import logging

import pytest

from mirage.utils import abort as abort_module
from mirage.utils.abort import (
    ABORT_JOIN_SECONDS,
    MirageAbortError,
    run_cancellable,
)


@pytest.mark.asyncio
async def test_abort_wins_over_a_task_that_finished_in_the_same_tick():
    # The event is the caller's; once it is set the answer is the abort,
    # even when the task reached its return in the same tick, and the
    # task's finally has run before the caller hears back.
    cancel = asyncio.Event()
    finished: list[bool] = []

    async def body() -> int:
        try:
            cancel.set()
            await asyncio.sleep(0)
            return 1
        finally:
            finished.append(True)

    with pytest.raises(MirageAbortError):
        await run_cancellable(body(), cancel)
    assert finished == [True]


@pytest.mark.asyncio
async def test_a_task_that_finishes_first_reports_its_own_outcome():
    cancel = asyncio.Event()

    async def body() -> int:
        await asyncio.sleep(0)
        return 3

    assert await run_cancellable(body(), cancel) == 3
    assert not cancel.is_set()


@pytest.mark.asyncio
async def test_a_stalled_task_is_cancelled_and_joined():
    cancel = asyncio.Event()
    unwound: list[bool] = []

    async def body() -> None:
        try:
            await asyncio.Event().wait()
        finally:
            unwound.append(True)

    asyncio.get_running_loop().call_later(0.01, cancel.set)
    with pytest.raises(MirageAbortError):
        await run_cancellable(body(), cancel)
    assert unwound == [True]


@pytest.mark.asyncio
async def test_an_epilogue_that_outlives_the_grace_is_cancelled_too():
    # The first cancel lands on the body; the task's finally then awaits
    # something that never settles. The caller is still released, after
    # the grace, and the task is done when it is.
    cancel = asyncio.Event()
    steps: list[str] = []

    async def body() -> None:
        try:
            await asyncio.Event().wait()
        finally:
            steps.append("epilogue")
            try:
                await asyncio.Event().wait()
            finally:
                steps.append("released")

    asyncio.get_running_loop().call_later(0.01, cancel.set)
    started = asyncio.get_running_loop().time()
    with pytest.raises(MirageAbortError):
        await run_cancellable(body(), cancel)
    elapsed = asyncio.get_running_loop().time() - started
    assert steps == ["epilogue", "released"]
    assert ABORT_JOIN_SECONDS <= elapsed < ABORT_JOIN_SECONDS + 1


@pytest.mark.asyncio
async def test_an_externally_cancelled_caller_gets_the_same_grace():
    # The event was never set: the abort arrives as a cancel on this
    # frame, from a wait_for. The line still gets both deliveries and
    # the grace between them, so the epilogue is not the thing that
    # holds the caller.
    cancel = asyncio.Event()
    steps: list[str] = []

    async def body() -> None:
        try:
            await asyncio.Event().wait()
        finally:
            steps.append("epilogue")
            try:
                await asyncio.Event().wait()
            finally:
                steps.append("released")

    before = asyncio.all_tasks()
    started = asyncio.get_running_loop().time()
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(run_cancellable(body(), cancel), 0.01)
    elapsed = asyncio.get_running_loop().time() - started
    assert steps == ["epilogue", "released"]
    assert ABORT_JOIN_SECONDS <= elapsed < ABORT_JOIN_SECONDS + 1
    assert not (asyncio.all_tasks() - before)


async def _fail() -> None:
    await asyncio.sleep(0)
    raise ValueError("lost")


@pytest.mark.asyncio
async def test_a_failure_its_cancelled_caller_left_is_read_and_logged(caplog):
    # The caller is cancelled in the turn its line fails, so its wait is
    # cut short with the failure unread. It is logged here instead of
    # left for asyncio to report as never retrieved. The line waits once
    # first: an eager start would otherwise fail it before the caller
    # ever waits.
    loop = asyncio.get_running_loop()
    reported: list[dict] = []
    handler = loop.get_exception_handler()
    loop.set_exception_handler(lambda _, context: reported.append(context))
    caller = asyncio.ensure_future(run_cancellable(_fail(), asyncio.Event()))
    await asyncio.sleep(0)
    caller.cancel()
    try:
        with caplog.at_level(logging.DEBUG, logger="mirage.utils.abort"):
            await asyncio.wait({caller})
        del caller
        gc.collect()
    finally:
        loop.set_exception_handler(handler)
    assert not reported
    assert any(
        r.exc_info and isinstance(r.exc_info[1], ValueError)
        for r in caplog.records
    )


@pytest.mark.asyncio
async def test_a_body_that_swallows_both_cancels_is_joined_and_warned(
    monkeypatch, caplog
):
    # Neither cancel can be forced through a body that swallows them,
    # which is asyncio's own limit too. The caller waits for the body to
    # return, and the wait is named in the log rather than silent.
    monkeypatch.setattr(abort_module, "ABORT_STALL_WARN_SECONDS", 0.05)
    cancel = asyncio.Event()
    steps: list[str] = []

    async def body() -> None:
        for _ in range(2):
            try:
                await asyncio.sleep(10)
            except asyncio.CancelledError:
                # The bad handler this test exists to describe.
                pass
        await asyncio.sleep(0.2)
        steps.append("returned")

    asyncio.get_running_loop().call_later(0.01, cancel.set)
    with caplog.at_level(logging.WARNING, logger="mirage.utils.abort"):
        with pytest.raises(MirageAbortError):
            await run_cancellable(body(), cancel)
    assert steps == ["returned"]
    assert any(
        "not letting CancelledError propagate" in r.getMessage()
        for r in caplog.records
    )
