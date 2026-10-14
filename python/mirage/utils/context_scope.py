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

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Generator
from contextvars import Context, copy_context
from typing import Any, Generic, ParamSpec, TypeVar, cast

P = ParamSpec("P")
T = TypeVar("T")


class InlineAwait(Generic[T]):
    """Await an awaitable inside the awaiting task, each step in a context.

    asyncio runs a coroutine in another context, or lets another task
    cancel it, only through a task of its own, and a task costs two turns
    of the event loop: on a command's output that is most of what one
    write costs. This drives the awaitable's own steps instead and hands
    the event loop each future a step waits on, so the awaiting task waits
    on it directly. ``cancel`` does what cancelling such a task would: it
    cancels the future the step waits on, or throws CancelledError into
    the next step.

    Args:
        awaitable (Awaitable[T]): what to await, once.
        context (Context | None): where each step runs; None runs it in
            the awaiting task's own context.
    """

    def __init__(
        self, awaitable: Awaitable[T], context: Context | None = None
    ) -> None:
        self._awaitable = awaitable
        self._context = context
        self._waiting: Any = None
        self._cancelling = False
        self._finished = False
        self._ended: asyncio.Future[None] | None = None

    def cancel(self) -> None:
        """Cancel the step in flight, or the next one to run."""
        waiting = self._waiting
        if isinstance(waiting, asyncio.Future) and waiting.cancel():
            return
        self._cancelling = True

    def ended(self) -> asyncio.Future[None]:
        """A future that resolves once the last step has run."""
        if self._ended is None:
            self._ended = asyncio.get_running_loop().create_future()
            if self._finished:
                self._ended.set_result(None)
        return self._ended

    def _step(
        self, steps: Any, value: Any, error: BaseException | None
    ) -> Any:
        if error is not None:
            call = steps.throw
            arg: Any = error
        else:
            call, arg = steps.send, value
        if self._context is None:
            return call(arg)
        return self._context.run(call, arg)

    def __await__(self) -> Generator[Any, None, T]:
        steps = self._awaitable.__await__()
        value: Any = None
        error: BaseException | None = None
        try:
            while True:
                if self._cancelling and error is None:
                    self._cancelling = False
                    error = asyncio.CancelledError()
                try:
                    yielded = self._step(steps, value, error)
                except StopIteration as stop:
                    return cast(T, stop.value)
                self._waiting = yielded
                try:
                    value, error = (yield yielded), None
                except GeneratorExit:
                    if self._context is None:
                        steps.close()
                    else:
                        self._context.run(steps.close)
                    raise
                except BaseException as exc:
                    value, error = None, exc
                finally:
                    self._waiting = None
        finally:
            self._finished = True
            if self._ended is not None and not self._ended.done():
                self._ended.set_result(None)


class ContextScope:
    """Replay a captured context independently for each callback or task."""

    def __init__(self) -> None:
        self._context = copy_context()

    def call(self, fn: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
        return self._context.copy().run(fn, *args, **kwargs)

    async def run(self, fn: Callable[[], Awaitable[T]]) -> T:
        return await self.call(lambda: asyncio.ensure_future(fn()))

    def wrap(self, fn: Callable[P, T]) -> Callable[P, T]:
        def call(*args: P.args, **kwargs: P.kwargs) -> T:
            return self.call(fn, *args, **kwargs)

        return call

    def wrap_async(
        self, fn: Callable[P, Awaitable[T]]
    ) -> Callable[P, Awaitable[T]]:
        async def call(*args: P.args, **kwargs: P.kwargs) -> T:
            return await self.run(lambda: fn(*args, **kwargs))

        return call

    def stream(self, source: AsyncIterator[T]) -> AsyncIterator[T]:
        """Replay the producer's admission context for each lazy step.

        Args:
            source (AsyncIterator[T]): the lazy output to step through.

        Returns:
            AsyncIterator[T]: the same items, each fetched in the context.
        """
        context = self._context.copy()

        async def iterate() -> AsyncIterator[T]:
            iterator = source.__aiter__()
            try:
                while True:
                    try:
                        value = await InlineAwait(
                            iterator.__anext__(), context
                        )
                    except StopAsyncIteration:
                        return
                    yield value
            finally:
                close = getattr(iterator, "aclose", None)
                if close is not None:

                    async def finish() -> None:
                        await close()

                    await asyncio.create_task(finish(), context=context)

        return iterate()
