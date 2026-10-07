from typing import Any

from mirage.context.types import IOContext
from mirage.io import IOResult
from mirage.runtime.types import DispatchFn
from mirage.types import PathSpec


def bind_dispatch(dispatch: DispatchFn, context: IOContext) -> DispatchFn:
    """Bind the caller's access facts to its operation door.

    Args:
        dispatch (DispatchFn): the workspace's operation dispatcher.
        context (IOContext): access facts of this evaluation or command.
    """

    async def bound(
        op: str, path: PathSpec, **kwargs: Any
    ) -> tuple[Any, IOResult]:
        kwargs.setdefault("_io_context", context)
        return await dispatch(op, path, **kwargs)

    return bound


def bind_redirects(
    dispatch: DispatchFn, targets: tuple[str, ...]
) -> DispatchFn:
    """Mark the redirect paths admitted with this statement."""

    async def bound(
        op: str, path: PathSpec, **kwargs: Any
    ) -> tuple[Any, IOResult]:
        kwargs.setdefault("_judged_targets", targets)
        return await dispatch(op, path, **kwargs)

    return bound
