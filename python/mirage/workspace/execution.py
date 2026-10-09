import asyncio
from collections.abc import Awaitable, Callable

from mirage.execution.context import new_execution_id
from mirage.io.yield_budget import YieldBudget
from mirage.workspace.abort import MirageAbortError


class ExecutionScope:
    """Identity and scheduling budget shared by a call and its evaluations."""

    def __init__(
        self,
        on_start: Callable[[], Awaitable[None]] | None = None,
        execution_id: str | None = None,
    ) -> None:
        self.id = execution_id or new_execution_id()
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
