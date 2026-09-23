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

    A shared loop is honored whether or not something is driving it: a
    running one (FUSE, which serves it from its own thread) takes
    run_coroutine_threadsafe, an idle one (a ``with ws:`` block, whose
    caller is the only thread there is) is driven per call. Both keep
    every call on ONE loop, which is what a VFS holding a
    connection pool needs to still be closable at the end.

    Args:
        awaitable (Awaitable[T]): The asynchronous operation to run.
        loop (asyncio.AbstractEventLoop | None): Shared event loop.
            If omitted, each call gets a throwaway loop.
    """
    try:
        running_loop = asyncio.get_running_loop()
    except RuntimeError:
        running_loop = None

    if loop is not None and loop is not running_loop:
        if loop.is_running():
            future = asyncio.run_coroutine_threadsafe(_await_result(awaitable),
                                                      loop)
            return future.result()
        if running_loop is None:
            return loop.run_until_complete(_await_result(awaitable))
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            return pool.submit(loop.run_until_complete,
                               _await_result(awaitable)).result()
    if running_loop is None:
        return _run_in_new_loop(awaitable)
    with concurrent.futures.ThreadPoolExecutor(1) as pool:
        return pool.submit(_run_in_new_loop, awaitable).result()
