import asyncio
import time
from copy import deepcopy
from dataclasses import replace
from typing import Any

from mirage.execution.base import ExecutionStore
from mirage.execution.types import ExecutionRecord


class RAMExecutionStore(ExecutionStore):
    """One event loop owns the records; only completed records expire."""

    def __init__(
        self, max_completed: int = 1024, retention_seconds: float = 3600
    ) -> None:
        if max_completed < 1 or retention_seconds <= 0:
            raise ValueError("execution retention limits must be positive")
        self._records: dict[str, ExecutionRecord] = {}
        self._completed: dict[str, ExecutionRecord] = {}
        self._listeners: set[asyncio.Future[None]] = set()
        self._closed = False
        self._max_completed = max_completed
        self._retention_seconds = retention_seconds

    def _prune(self) -> None:
        if self._closed:
            raise RuntimeError("execution store is closed")
        cutoff = time.time() - self._retention_seconds
        for execution_id, record in sorted(
            self._completed.items(), key=lambda item: item[1].finished_at or 0
        ):
            if (
                len(self._completed) <= self._max_completed
                and record.finished_at is not None
                and record.finished_at > cutoff
            ):
                break
            del self._completed[execution_id]
            del self._records[execution_id]

    def _notify(self) -> None:
        for listener in self._listeners:
            if not listener.done():
                listener.set_result(None)

    async def create(self, record: ExecutionRecord) -> bool:
        self._prune()
        if record.id in self._records:
            return False
        snapshot = deepcopy(record)
        self._records[record.id] = snapshot
        if record.finished_at is not None:
            self._completed[record.id] = snapshot
        self._prune()
        self._notify()
        return True

    async def get(self, execution_id: str) -> ExecutionRecord | None:
        self._prune()
        return deepcopy(self._records.get(execution_id))

    async def list(
        self, workspace_id: str | None = None
    ) -> list[ExecutionRecord]:
        self._prune()
        return [
            replace(r, result=None)
            for r in self._records.values()
            if workspace_id is None or r.workspace_id == workspace_id
        ]

    async def compare_and_set(
        self, record: ExecutionRecord, revision: int
    ) -> bool:
        self._prune()
        previous = self._records.get(record.id)
        if (
            previous is None
            or previous.revision != revision
            or previous.finished_at is not None
        ):
            return False
        if record.revision != revision + 1:
            raise ValueError("replacement must increment the revision")
        if previous.cancel_requested and not record.cancel_requested:
            raise ValueError("cancellation intent cannot be cleared")
        if (record.workspace_id, record.session_id, record.command) != (
            previous.workspace_id,
            previous.session_id,
            previous.command,
        ):
            raise ValueError("execution identity cannot change")
        snapshot = deepcopy(record)
        self._records[record.id] = snapshot
        if record.finished_at is not None:
            self._completed[record.id] = snapshot
        self._prune()
        self._notify()
        return True

    async def wait_for_change(
        self,
        execution_id: str,
        revision: int,
        timeout: float | None = None,
        cancel: asyncio.Event | None = None,
    ) -> ExecutionRecord | None:
        loop = asyncio.get_running_loop()
        deadline = None if timeout is None else loop.time() + timeout
        stop = None if cancel is None else asyncio.ensure_future(cancel.wait())
        try:
            while True:
                changed: asyncio.Future[None] = loop.create_future()
                self._listeners.add(changed)
                try:
                    record = await self.get(execution_id)
                    remaining = (
                        None if deadline is None else deadline - loop.time()
                    )
                    if (
                        record is None
                        or record.revision != revision
                        or (remaining is not None and remaining <= 0)
                        or (cancel is not None and cancel.is_set())
                    ):
                        return record
                    wakes: set[asyncio.Future[Any]] = {changed}
                    if stop is not None:
                        wakes.add(stop)
                    await asyncio.wait(
                        wakes,
                        timeout=remaining,
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                finally:
                    self._listeners.discard(changed)
        finally:
            if stop is not None:
                stop.cancel()

    async def close(self) -> None:
        self._closed = True
        self._notify()
