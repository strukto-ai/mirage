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
import sys
from collections.abc import (
    AsyncGenerator,
    AsyncIterator,
    Awaitable,
    Callable,
    Coroutine,
    Sequence,
)
from contextlib import AbstractAsyncContextManager
from typing import Any, ParamSpec, TypeVar, cast

logger = logging.getLogger(__name__)


class ConcurrencyLimiter:
    """Limit concurrent async operations within one process.

    Args:
        max_concurrency (int): Maximum number of simultaneous operations.
    """

    def __init__(self, max_concurrency: int) -> None:
        if max_concurrency < 1:
            raise ValueError("max_concurrency must be at least 1")
        self._semaphore = asyncio.Semaphore(max_concurrency)

    def acquire(self) -> AbstractAsyncContextManager[None]:
        """Return a context manager that holds one concurrency permit."""
        return self._semaphore


_T = TypeVar("_T")
_R = TypeVar("_R")
_P = ParamSpec("_P")


async def run_blocking(
    fn: Callable[_P, _R], *args: _P.args, **kwargs: _P.kwargs
) -> _R:
    """Run blocking work off-loop, retaining ownership until its thread ends.

    Args:
        fn (Callable): synchronous operation; receives the caller's context.
        args (_P.args): positional arguments to the operation.
        kwargs (_P.kwargs): keyword arguments to the operation.
    """
    worker = asyncio.create_task(asyncio.to_thread(fn, *args, **kwargs))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        try:
            await settle(worker)
        except Exception:
            logger.debug(
                "blocking operation failed during cancellation", exc_info=True
            )
        raise


async def bounded_map(
    items: Sequence[_T], fn: Callable[[_T], Awaitable[_R]], workers: int
) -> list[_R]:
    """Map in order with bounded tasks, settling every worker on failure.

    Args:
        items (Sequence): inputs in result order.
        fn (Callable): async operation for one input.
        workers (int): maximum concurrent operations, at least one.
    """
    remaining = iter(enumerate(items))
    failed = False
    results: list[_R | None] = [None] * len(items)

    async def worker() -> None:
        nonlocal failed
        try:
            for index, item in remaining:
                if failed:
                    return
                results[index] = await fn(item)
        except BaseException:
            failed = True
            raise

    tasks = [
        asyncio.create_task(worker())
        for _ in range(min(max(1, workers), len(items)))
    ]
    try:
        await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    return cast(list[_R], results)


async def settle(task: asyncio.Future[_R]) -> _R:
    """Wait for owned work to finish, deferring the caller's cancellation.

    Args:
        task (asyncio.Future): work that must not outlive its caller.
    """
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            logger.debug("deferring cancellation until owned work settles")
    return task.result()


def owned_task(coro: Coroutine[Any, Any, _R]) -> asyncio.Task[_R]:
    """Start work its caller will ``settle``, eagerly where Python can.

    From Python 3.12 the task runs up to its first wait before this
    returns, so work that never waits is already done: settling it
    takes no turn of the event loop, where a task started on the next
    turn costs three (its start and ``shield``'s two callbacks), each a
    slice of whatever else runs on the loop. Work that does wait goes on
    as an ordinary task, which the caller's cancellation still cannot
    cut short. Python 3.11 starts it on the next turn.

    Args:
        coro (Coroutine): the owned work.
    """
    loop = asyncio.get_running_loop()
    if sys.version_info >= (3, 12):
        return asyncio.Task(coro, loop=loop, eager_start=True)
    return loop.create_task(coro)


async def on_loop(work: Awaitable[_R], loop: asyncio.AbstractEventLoop) -> _R:
    """Await ``work`` on ``loop``, its result handed back to this one.

    The one hop between event loops: a hosted workspace runs on its
    runner's loop while a server's transports live on the server's. On
    ``loop`` itself the work is awaited in place. A cancelled caller
    cancels the work there and returns only once it has settled, so
    nothing it holds outlives the call.

    Args:
        work (Awaitable[_R]): the work, not yet started.
        loop (asyncio.AbstractEventLoop): the loop it runs on.
    """
    if asyncio.get_running_loop() is loop:
        return await work
    task: asyncio.Task[Any] | None = None
    canceled = False

    async def run() -> _R:
        nonlocal task
        if canceled:
            if isinstance(work, Coroutine):
                work.close()
            raise asyncio.CancelledError()
        task = asyncio.current_task()
        return await work

    def cancel() -> None:
        nonlocal canceled
        canceled = True
        if task is not None:
            task.cancel()

    result = asyncio.wrap_future(asyncio.run_coroutine_threadsafe(run(), loop))
    try:
        return await asyncio.shield(result)
    except asyncio.CancelledError:
        loop.call_soon_threadsafe(cancel)
        try:
            await settle(result)
        except Exception:
            logger.debug(
                "a call on another loop failed during cancellation",
                exc_info=True,
            )
        raise


async def bounded_map_stream(
    items: AsyncIterator[_T], fn: Callable[[_T], Awaitable[_R]], workers: int
) -> AsyncGenerator[_R, None]:
    """Map a stream in input order, owning every admitted task until it settles.

    Args:
        items (AsyncIterator): input, pulled only while a slot is free.
        fn (Callable): work for one input.
        workers (int): outstanding results allowed; zero means unlimited.
    """
    permits = asyncio.Semaphore(workers) if workers else None
    ready: asyncio.Queue[asyncio.Future[_R] | None] = asyncio.Queue()
    active: set[asyncio.Future[_R]] = set()

    async def produce() -> None:
        try:
            while True:
                if permits is not None:
                    await permits.acquire()
                try:
                    item = await anext(items)
                except StopAsyncIteration:
                    return
                task = asyncio.ensure_future(fn(item))
                active.add(task)
                ready.put_nowait(task)
        finally:
            ready.put_nowait(None)

    producer = asyncio.create_task(produce())
    try:
        while (task := await ready.get()) is not None:
            result = await task
            active.remove(task)
            yield result
            if permits is not None:
                permits.release()
        await producer
    finally:
        producer.cancel()
        for task in active:
            task.cancel()
        await asyncio.gather(producer, *active, return_exceptions=True)
        close = getattr(items, "aclose", None)
        if close is not None:
            await close()
