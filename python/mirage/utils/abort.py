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
import logging
from collections.abc import Coroutine
from typing import Any, TypeVar

logger = logging.getLogger(__name__)


class MirageAbortError(RuntimeError):
    def __init__(self) -> None:
        super().__init__("execute aborted")


async def cancellable_sleep(
    seconds: float,
    cancel: asyncio.Event | None = None,
) -> None:
    await run_cancellable(asyncio.sleep(seconds), cancel)


_T = TypeVar("_T")

# How long a cancelled line's epilogue gets before it is cancelled too;
# the twin of TypeScript's ABORT_JOIN_MS.
ABORT_JOIN_SECONDS = 0.25

# How often a join that both cancels failed to end is reported.
ABORT_STALL_WARN_SECONDS = 5.0


async def _cancel_and_join(task: "asyncio.Task[Any]") -> None:
    """Cancel ``task``, give its epilogue the grace, then join it.

    The first cancel lands on the await the body is in; the line's
    ``finally`` gets ``ABORT_JOIN_SECONDS`` to flush and record before a
    second one lands on it. A body that swallows both cannot be forced
    to finish, so the join stays unbounded and says so: every
    ``ABORT_STALL_WARN_SECONDS`` it names the wait.

    Args:
        task (asyncio.Task): the running line to cancel and join.
    """
    task.cancel()
    done, _ = await asyncio.wait({task}, timeout=ABORT_JOIN_SECONDS)
    if not done:
        task.cancel()
        started = asyncio.get_running_loop().time()
        while not done:
            done, _ = await asyncio.wait(
                {task}, timeout=ABORT_STALL_WARN_SECONDS
            )
            if not done:
                logger.warning(
                    "line still running %.1fs after cancel; a handler or "
                    "store is not letting CancelledError propagate",
                    asyncio.get_running_loop().time() - started,
                )
    await asyncio.gather(task, return_exceptions=True)


async def run_cancellable(
    coro: Coroutine[Any, Any, _T],
    cancel: asyncio.Event | None,
    stop: asyncio.Event | None = None,
) -> _T:
    """Run ``coro`` as a task the caller's event can cancel, and join it.

    The task is the cancellation seam: a cancelled asyncio task unwinds
    at its next await, whatever it was awaiting, so every await inside
    ``coro`` observes the event without being handed it. The task is
    joined before the abort is reported, so nothing of the line is
    still running when the caller hears back.

    The event is the caller's alone; nothing in the line sets it. So an
    event found set here is always the caller's abort, and it wins even
    over a task that finished in the same tick, the recheck TypeScript
    makes after the last await of ``executeLine``.

    The cancel is delivered once, at the await the body is in. The
    line's ``finally`` then flushes the session and records the line,
    fresh awaits a store that has gone away can hold forever. So the
    epilogue gets ``ABORT_JOIN_SECONDS``, the grace TypeScript gives a
    cancelled tree, and is cancelled too when it outlives it; the join
    still completes, and the caller is released.

    A caller cancelled from outside, by ``asyncio.wait_for``, a request
    timeout or a task group, gets that same grace: the abort arriving
    here rather than on the event changes nothing about how the line is
    wound down.

    The contract for a handler or store author is that
    ``CancelledError`` must propagate. A body that swallows both
    deliveries cannot be forced to finish, and it holds ``shell``
    until it returns, exactly as it holds ``asyncio.wait_for``, a
    ``TaskGroup`` and ``asyncio.run``'s shutdown. The wait is not
    silent: it is logged as a warning every
    ``ABORT_STALL_WARN_SECONDS`` until the task ends.

    With neither event the line runs inline, so external cancellation
    is plain asyncio: one delivery, at the await the line is in, and no
    grace for the epilogue.

    Args:
        coro (Coroutine): the work to run, a whole line or a subtree.
        cancel (asyncio.Event | None): the caller's abort event.
        stop (asyncio.Event | None): the workspace's own abort for this
            line (``Workspace.cancel``), honored the same way.
    """
    events = [e for e in (cancel, stop) if e is not None]
    if not events:
        return await coro
    task = asyncio.ensure_future(coro)
    waiters = [asyncio.create_task(e.wait()) for e in events]
    try:
        await asyncio.wait(
            {task, *waiters}, return_when=asyncio.FIRST_COMPLETED
        )
        if any(e.is_set() for e in events):
            await _cancel_and_join(task)
            raise MirageAbortError()
        return await task
    finally:
        for waiter in waiters:
            waiter.cancel()
        if not task.done():
            await _cancel_and_join(task)
        await asyncio.gather(task, *waiters, return_exceptions=True)
