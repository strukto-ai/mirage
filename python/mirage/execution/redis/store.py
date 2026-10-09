import asyncio
import json
import math
import time
from dataclasses import asdict
from typing import Any

import redis.asyncio as aioredis

from mirage.execution.base import ExecutionStore
from mirage.execution.redis.constants import POLL_SECONDS, STORE_LUA
from mirage.execution.types import ExecutionRecord, ExecutionStatus


def encode(record: ExecutionRecord) -> tuple[str, str]:
    fields = asdict(record)
    result = fields.pop("result")
    return (
        json.dumps(fields, ensure_ascii=False, allow_nan=False),
        json.dumps(result, ensure_ascii=False, allow_nan=False),
    )


def decode(raw: bytes, result: bytes | None = None) -> ExecutionRecord:
    fields = json.loads(raw)
    fields["status"] = ExecutionStatus(fields["status"])
    if result is not None:
        fields["result"] = json.loads(result)
    return ExecutionRecord(**fields)


class RedisExecutionStore(ExecutionStore):
    """Shared execution snapshots with atomic revisions and completed retention.

    The snake_case JSON schema is shared with TypeScript. Results live in
    their own hash, so a listing never reads them. Active records never
    expire; reads and writes prune completed records by age and count. Waiters
    poll revisions, so a change before registration is not lost. Closing this
    instance releases its connection and waiters without deleting records.
    Running work, worker ownership and restart recovery stay with the executor.

    Args:
        url (str): Redis connection URL.
        key_prefix (str): namespace shared by readers and writers. Redis Cluster
            requires a shared hash tag, as used by the default prefix.
        max_completed (int): maximum retained completed records.
        retention_seconds (float): maximum completed age in seconds.
    """

    def __init__(
        self,
        url: str = "redis://localhost:6379/0",
        key_prefix: str = "mirage:{executions}:",
        max_completed: int = 1024,
        retention_seconds: float = 3600,
    ) -> None:
        if (
            max_completed < 1
            or not math.isfinite(retention_seconds)
            or retention_seconds <= 0
        ):
            raise ValueError("execution retention limits must be positive")
        self.key_prefix = key_prefix
        self._client = aioredis.from_url(url)
        self._script = self._client.register_script(STORE_LUA)
        self._keys = [
            f"{key_prefix}records",
            f"{key_prefix}completed",
            f"{key_prefix}results",
        ]
        self._max_completed = max_completed
        self._retention_seconds = retention_seconds
        self._closed = asyncio.Event()

    async def _call(
        self,
        operation: str,
        execution_id: str = "",
        data: tuple[str, str] = ("", ""),
        revision: int = 0,
    ) -> Any:
        if self._closed.is_set():
            raise RuntimeError("execution store is closed")
        return await self._script(
            keys=self._keys,
            args=[
                operation,
                execution_id,
                repr(time.time()),
                repr(self._retention_seconds),
                str(self._max_completed),
                data[0],
                str(revision),
                data[1],
            ],
        )

    async def create(self, record: ExecutionRecord) -> bool:
        return bool(await self._call("create", record.id, encode(record)) == 1)

    async def get(self, execution_id: str) -> ExecutionRecord | None:
        raw, result = await self._call("get", execution_id)
        return decode(raw, result) if raw is not None else None

    async def list(
        self, workspace_id: str | None = None
    ) -> list[ExecutionRecord]:
        records = [decode(raw) for raw in await self._call("list")]
        return [
            record
            for record in records
            if workspace_id is None or record.workspace_id == workspace_id
        ]

    async def compare_and_set(
        self, record: ExecutionRecord, revision: int
    ) -> bool:
        outcome = await self._call("cas", record.id, encode(record), revision)
        if outcome == -1:
            raise ValueError("replacement must increment the revision")
        if outcome == -2:
            raise ValueError("cancellation intent cannot be cleared")
        if outcome == -3:
            raise ValueError("execution identity cannot change")
        return bool(outcome == 1)

    async def wait_for_change(
        self,
        execution_id: str,
        revision: int,
        timeout: float | None = None,
        cancel: asyncio.Event | None = None,
    ) -> ExecutionRecord | None:
        loop = asyncio.get_running_loop()
        deadline = None if timeout is None else loop.time() + timeout
        wakes = [asyncio.create_task(self._closed.wait())]
        if cancel is not None:
            wakes.append(asyncio.create_task(cancel.wait()))
        try:
            while True:
                record = await self.get(execution_id)
                remaining = (
                    POLL_SECONDS
                    if deadline is None
                    else min(POLL_SECONDS, deadline - loop.time())
                )
                if (
                    record is None
                    or record.revision != revision
                    or remaining <= 0
                    or (cancel is not None and cancel.is_set())
                ):
                    return record
                await asyncio.wait(
                    wakes,
                    timeout=remaining,
                    return_when=asyncio.FIRST_COMPLETED,
                )
        finally:
            for wake in wakes:
                wake.cancel()
            await asyncio.gather(*wakes, return_exceptions=True)

    async def close(self) -> None:
        self._closed.set()
        await self._client.aclose()
