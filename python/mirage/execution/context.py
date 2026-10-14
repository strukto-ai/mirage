from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from typing import TypeVar

from mirage.utils.ids import uuid7

_current: ContextVar[str | None] = ContextVar("execution_id", default=None)
T = TypeVar("T")


def new_execution_id() -> str:
    return f"exec_{uuid7()}"


def current_execution_id() -> str | None:
    return _current.get()


async def run_with_execution(
    execution_id: str, run: Callable[[], Awaitable[T]]
) -> T:
    token = _current.set(execution_id)
    try:
        return await run()
    finally:
        _current.reset(token)
