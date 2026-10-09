from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from typing import TypeVar

from mirage.execution.types import ExecutionIdentity
from mirage.utils.ids import uuid7

_current: ContextVar[ExecutionIdentity | None] = ContextVar(
    "execution_identity", default=None
)
T = TypeVar("T")


def new_execution_id() -> str:
    return f"exec_{uuid7()}"


def current_execution() -> ExecutionIdentity | None:
    return _current.get()


def current_execution_id() -> str | None:
    identity = current_execution()
    return identity.id if identity is not None else None


async def run_with_execution(
    identity: ExecutionIdentity, run: Callable[[], Awaitable[T]]
) -> T:
    token = _current.set(identity)
    try:
        return await run()
    finally:
        _current.reset(token)
