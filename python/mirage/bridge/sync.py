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
import concurrent.futures
from collections.abc import Awaitable
from typing import TypeVar

T = TypeVar("T")


async def _await_result(awaitable: Awaitable[T]) -> T:
    return await awaitable


def _run_in_new_loop(awaitable: Awaitable[T]) -> T:
    return asyncio.run(_await_result(awaitable))


def run_async_from_sync(
    awaitable: Awaitable[T],
    loop: asyncio.AbstractEventLoop | None = None,
) -> T:
    """Call from a sync thread to run an async coroutine.

    Args:
        awaitable (Awaitable[T]): The asynchronous operation to run.
        loop (asyncio.AbstractEventLoop | None): Shared event loop.
            If provided, uses run_coroutine_threadsafe.
            If None, creates a new event loop.
    """
    try:
        running_loop = asyncio.get_running_loop()
    except RuntimeError:
        running_loop = None

    if loop is not None and loop.is_running() and loop is not running_loop:
        future = asyncio.run_coroutine_threadsafe(_await_result(awaitable),
                                                  loop)
        return future.result()
    if running_loop is None:
        return _run_in_new_loop(awaitable)
    with concurrent.futures.ThreadPoolExecutor(1) as pool:
        return pool.submit(_run_in_new_loop, awaitable).result()
