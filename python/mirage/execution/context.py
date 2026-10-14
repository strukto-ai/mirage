from collections.abc import Awaitable, Callable
from dataclasses import replace
from typing import TypeVar

from mirage.context import bind_caller, current_caller, reset_caller
from mirage.utils.ids import uuid7

T = TypeVar("T")


def new_execution_id() -> str:
    return f"exec_{uuid7()}"


def current_execution_id() -> str | None:
    return current_caller().execution_id


async def run_with_execution(
    execution_id: str, run: Callable[[], Awaitable[T]]
) -> T:
    token = bind_caller(replace(current_caller(), execution_id=execution_id))
    try:
        return await run()
    finally:
        reset_caller(token)
