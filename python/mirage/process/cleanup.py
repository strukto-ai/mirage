from collections.abc import Awaitable, Callable
from typing import TypeVar

T = TypeVar("T")


async def with_process_cleanup(run: Callable[[], Awaitable[T]]) -> T:
    return await run()
