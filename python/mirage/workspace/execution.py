import asyncio
from collections.abc import Awaitable, Callable

from mirage.io.yield_budget import YieldBudget
from mirage.utils.abort import MirageAbortError


class ExecutionScope:
    """One scheduling budget shared by a foreground call and its evaluations."""

    def __init__(
        self, on_start: Callable[[], Awaitable[None]] | None = None
    ) -> None:
        self._budget = YieldBudget()
        self._on_start = on_start

    async def start(self) -> None:
        """Publish admission once, after acquiring the session and before effects."""
        if self._on_start is not None:
            on_start, self._on_start = self._on_start, None
            await on_start()

    async def checkpoint(self, cancel: asyncio.Event | None = None) -> None:
        if cancel is not None and cancel.is_set():
            raise MirageAbortError()
        await self._budget.run()
        if cancel is not None and cancel.is_set():
            raise MirageAbortError()
