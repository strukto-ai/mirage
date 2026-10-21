import asyncio
import logging
import pickle
import struct
import sys
from collections.abc import Callable
from typing import Any, TypeVar, cast

from mirage.concurrency.limiter import settle

T = TypeVar("T")
HEADER = struct.Struct("!I")
logger = logging.getLogger(__name__)


class Worker:
    """Own a process for synchronous computation; cancellation kills and joins it."""

    def __init__(self) -> None:
        self._process: asyncio.subprocess.Process | None = None
        self._unread = 0
        self._lock = asyncio.Lock()
        self._starting: asyncio.Task[asyncio.subprocess.Process] | None = None
        self._closing: asyncio.Task[None] | None = None
        self._failure: BaseException | None = None

    async def call(self, fn: Callable[..., T], *args: Any) -> T:
        """Call an importable function away from the event loop and the GIL.

        Args:
            fn (Callable): a module-level function.
            args (Any): serializable computation inputs.
        """
        async with self._lock:
            await self.send(fn, *args)
            return cast(T, await self.receive())

    async def send(self, fn: Callable[..., Any], *args: Any) -> None:
        """Queue a call; ``receive`` returns the results in the order sent.

        The write is not drained: the request is already in memory, and
        waiting for the child to read it while the child waits for an
        earlier result to be read would deadlock.

        Args:
            fn (Callable): a module-level function.
            args (Any): serializable computation inputs.
        """
        try:
            if self._failure is not None:
                raise RuntimeError(
                    "computation worker transport failed"
                ) from self._failure
            if self._closing is not None and (
                not self._closing.done()
                or self._closing.cancelled()
                or self._closing.exception() is not None
            ):
                raise RuntimeError("computation worker is stopping")
            if self._process is None:
                self._closing = None
                starting = asyncio.create_task(
                    asyncio.create_subprocess_exec(
                        sys.executable,
                        "-m",
                        "mirage.concurrency.worker_entry",
                        stdin=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.PIPE,
                    )
                )
                self._starting = starting
                try:
                    self._process = await asyncio.shield(starting)
                except asyncio.CancelledError:
                    self._process = await settle(starting)
                    raise
                finally:
                    self._starting = None
            process = self._process
            if process.returncode is not None:
                raise RuntimeError("computation worker exited")
            assert process.stdin is not None
            data = pickle.dumps((fn.__module__, fn.__name__, args))
            process.stdin.write(HEADER.pack(len(data)) + data)
        except BaseException as exc:
            if not isinstance(exc, asyncio.CancelledError):
                self._failure = exc
            await self.close()
            raise

    def forget(self, count: int) -> None:
        """Drop the results of ``count`` calls sent but never received.

        Args:
            count (int): the calls whose results nobody will read.
        """
        self._unread += count

    async def receive(self) -> Any:
        """The result of the oldest call not yet received or forgotten."""
        try:
            process = self._process
            assert process is not None and process.stdout is not None
            while True:
                size = HEADER.unpack(
                    await process.stdout.readexactly(HEADER.size)
                )[0]
                data = await process.stdout.readexactly(size)
                if not self._unread:
                    break
                self._unread -= 1
            ok, result = pickle.loads(data)
        except BaseException as exc:
            if not isinstance(exc, asyncio.CancelledError):
                self._failure = exc
            await self.close()
            raise
        if not ok:
            raise result
        return result

    async def _stop(self) -> None:
        if self._starting is not None:
            self._process = await settle(self._starting)
        process = self._process
        if process is None:
            return
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                logger.debug("computation worker already exited")
        await process.communicate()
        if self._process is process:
            self._process = None
            self._unread = 0

    async def close(self, *, retry: bool = False) -> None:
        """Terminate and join, retaining a failed stop until explicitly retried.

        Args:
            retry (bool): retry a completed failed stop owned by this caller.
        """
        if self._closing is None or (
            retry
            and self._closing.done()
            and (
                self._closing.cancelled()
                or self._closing.exception() is not None
            )
        ):
            self._closing = asyncio.create_task(self._stop())
        await settle(self._closing)
