import asyncio
import logging
from collections import deque
from collections.abc import Callable
from contextlib import aclosing
from dataclasses import asdict, dataclass
from typing import Any, Literal, TypeVar, cast

from mirage.concurrency.limiter import settle
from mirage.concurrency.worker import Worker
from mirage.io.cooperative import chunks
from mirage.rs import diff_worker
from mirage.rs.diff_types import (
    DiffOptions,
    InputFactory,
    PairOutcome,
    PairResult,
)
from mirage.rs.errors import StreamRefusal

CHUNK_SIZE = 64 * 1024
WORKER_LIMIT = 2
IDLE_TTL = 1.0
QUEUE_LIMIT = 32
RETIRE_BYTES = 16 * 1024 * 1024
logger = logging.getLogger(__name__)
T = TypeVar("T")
EntryState = Literal["leased", "idle", "stopping", "stop_failed"]


@dataclass(eq=False, slots=True)
class _Entry:
    worker: Worker
    state: EntryState = "leased"
    lease: "_Lease | None" = None
    timer: asyncio.TimerHandle | None = None
    closing: asyncio.Task[None] | None = None


@dataclass(eq=False, slots=True)
class _Lease:
    entry: _Entry
    owner: asyncio.Task[Any] | None
    active: bool = True
    operation: asyncio.Task[Any] | None = None

    async def call(self, fn: Callable[..., T], *args: Any) -> T:
        if not self.active or self.entry.state != "leased":
            raise RuntimeError("diff worker lease is closed")
        if self.operation is not None:
            raise RuntimeError("diff worker is already computing")
        operation = asyncio.create_task(self.entry.worker.call(fn, *args))
        self.operation = operation
        try:
            return await operation
        except StreamRefusal:
            raise
        except Exception as exc:
            raise RuntimeError(f"diff worker failed: {exc}") from exc
        finally:
            if operation.done() and self.operation is operation:
                self.operation = None


class DiffPool:
    """Own a bounded set of reusable computation processes for one workspace."""

    def __init__(self) -> None:
        self._entries: set[_Entry] = set()
        self._waiting: deque[asyncio.Future[_Lease]] = deque()
        self._stopped = False
        self._close_task: asyncio.Task[None] | None = None
        self._cleanup_errors: list[Exception] = []
        self._retirements: set[asyncio.Task[None]] = set()

    def _dispatch(self) -> None:
        if self._stopped:
            return
        while self._waiting:
            future = self._waiting[0]
            if future.done():
                self._waiting.popleft()
                continue
            entry = next(
                (row for row in self._entries if row.state == "idle"), None
            )
            if entry is None:
                if len(self._entries) >= WORKER_LIMIT:
                    if all(
                        row.state == "stop_failed" for row in self._entries
                    ):
                        self._reject_waiters(
                            "diff workers could not be stopped"
                        )
                    return
                entry = _Entry(Worker())
                self._entries.add(entry)
            if entry.timer is not None:
                entry.timer.cancel()
                entry.timer = None
            entry.state = "leased"
            lease = _Lease(entry, None)
            entry.lease = lease
            self._waiting.popleft()
            future.set_result(lease)

    def _reject_waiters(self, message: str) -> None:
        while self._waiting:
            future = self._waiting.popleft()
            if not future.done():
                future.set_exception(RuntimeError(message))

    async def _acquire(self) -> _Lease:
        if self._stopped:
            raise RuntimeError("diff pool is closed")
        if sum(not item.done() for item in self._waiting) >= QUEUE_LIMIT:
            raise RuntimeError("diff worker queue is full")
        future: asyncio.Future[_Lease] = (
            asyncio.get_running_loop().create_future()
        )
        self._waiting.append(future)
        self._dispatch()
        try:
            lease = await asyncio.shield(future)
            lease.owner = asyncio.current_task()
            return lease
        except BaseException:
            if future.done() and not future.cancelled():
                if future.exception() is None:
                    await settle(self._retire(future.result().entry))
            else:
                future.cancel()
                self._waiting.remove(future)
                self._dispatch()
            raise

    def _retire(
        self, entry: _Entry, *, retry: bool = False
    ) -> asyncio.Task[None]:
        if entry.closing is not None and not (
            retry and entry.state == "stop_failed"
        ):
            return entry.closing
        entry.state = "stopping"
        if entry.timer is not None:
            entry.timer.cancel()
            entry.timer = None
        lease = entry.lease
        if lease is not None:
            lease.active = False
            if lease.operation is not None:
                lease.operation.cancel()
        task = asyncio.create_task(self._dispose(entry, retry=retry))
        entry.closing = task
        self._retirements.add(task)
        task.add_done_callback(self._retirements.discard)
        return task

    async def _dispose(self, entry: _Entry, *, retry: bool) -> None:
        lease = entry.lease
        if lease is not None and lease.operation is not None:
            await asyncio.gather(lease.operation, return_exceptions=True)
        try:
            await entry.worker.close(retry=retry)
        except Exception as exc:
            logger.debug("diff worker cleanup failed", exc_info=True)
            self._cleanup_errors.append(exc)
            entry.state = "stop_failed"
        else:
            entry.lease = None
            self._entries.remove(entry)
        self._dispatch()

    async def _release(self, lease: _Lease, size: int) -> None:
        entry = lease.entry
        if not lease.active or self._stopped or size > RETIRE_BYTES:
            await settle(self._retire(entry))
            return
        lease.active = False
        entry.lease = None
        entry.state = "idle"
        self._dispatch()
        if entry.state == "idle":
            if sum(row.state == "idle" for row in self._entries) > 1:
                await settle(self._retire(entry))
            else:
                entry.timer = asyncio.get_running_loop().call_later(
                    IDLE_TTL, self._expire, entry
                )

    def _expire(self, entry: _Entry) -> None:
        if entry.state == "idle" and entry in self._entries:
            self._retire(entry)

    @staticmethod
    def _append(parts: list[bytes], chunk: bytes) -> int:
        if not isinstance(chunk, bytes) or len(chunk) > CHUNK_SIZE:
            raise RuntimeError("invalid diff worker output chunk")
        if chunk:
            parts.append(chunk)
        return len(chunk)

    async def compare(
        self, options: DiffOptions, old: InputFactory, new: InputFactory
    ) -> PairResult:
        lease = await self._acquire()
        size = 0
        output: list[bytes] = []
        try:
            await lease.call(diff_worker.open_pair, asdict(options))
            for index, factory in enumerate((old, new)):
                async with aclosing(chunks(await factory())) as source:
                    async for chunk in source:
                        size += len(chunk)
                        reply = await lease.call(
                            diff_worker.feed, index, chunk
                        )
                        size += self._append(output, reply)
                size += self._append(
                    output, await lease.call(diff_worker.end, index)
                )
            busy = True
            while busy:
                drain_reply = await lease.call(diff_worker.drain)
                if not isinstance(drain_reply, tuple) or len(drain_reply) != 2:
                    raise RuntimeError("invalid diff worker drain reply")
                chunk, busy = drain_reply
                if not isinstance(busy, bool):
                    raise RuntimeError("invalid diff worker busy state")
                size += self._append(output, chunk)
            outcome, status, stderr = await lease.call(
                diff_worker.inspect_pair
            )
            if (
                type(status) is not int
                or outcome not in ("equal", "different")
                or status not in (0, 1, 2)
                or (status < 2 and status != (outcome == "different"))
            ):
                raise RuntimeError("invalid diff worker outcome")
            if not isinstance(stderr, bytes) or len(stderr) > CHUNK_SIZE:
                raise RuntimeError("invalid diff worker diagnostics")
            await lease.call(diff_worker.drop_pair)
            result = PairResult(
                cast(PairOutcome, outcome),
                tuple(output),
                cast(Literal[0, 1, 2], status),
                (stderr,) if stderr else (),
            )
            size += len(stderr)
            await self._release(lease, size)
            return result
        except BaseException:
            await settle(self._retire(lease.entry))
            raise
        finally:
            lease.owner = None

    def stop(self) -> None:
        """Reject new and queued comparisons before workspace teardown yields."""
        self._stopped = True
        self._reject_waiters("diff pool is closed")

    async def _finish_close(self) -> None:
        owners = {
            entry.lease.owner
            for entry in self._entries
            if entry.lease is not None and entry.lease.owner is not None
        }
        for owner in owners:
            owner.cancel()
        await asyncio.gather(
            *(self._retire(entry) for entry in tuple(self._entries)),
            return_exceptions=True,
        )
        failed = [
            entry for entry in self._entries if entry.state == "stop_failed"
        ]
        await asyncio.gather(
            *(self._retire(entry, retry=True) for entry in failed),
            return_exceptions=True,
        )
        if owners:
            await asyncio.gather(*owners, return_exceptions=True)
        while self._retirements:
            await asyncio.gather(
                *tuple(self._retirements), return_exceptions=True
            )
        if self._cleanup_errors:
            raise ExceptionGroup(
                "diff worker cleanup failed", self._cleanup_errors
            )

    async def close(self) -> None:
        """Settle every owned worker and preserve cleanup failures on later calls."""
        self.stop()
        if self._close_task is None:
            self._close_task = asyncio.create_task(self._finish_close())
        await settle(self._close_task)
