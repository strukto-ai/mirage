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
from collections.abc import AsyncIterator, Awaitable, Callable
from contextvars import copy_context
from typing import ParamSpec, TypeVar

P = ParamSpec("P")
T = TypeVar("T")


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

            async def advance() -> T:
                return await iterator.__anext__()

            try:
                while True:
                    try:
                        value = await asyncio.create_task(
                            advance(), context=context
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
