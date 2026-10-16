import asyncio
import logging
from collections.abc import Awaitable, Callable

from mirage.io.errors import PipeClosed
from mirage.io.pipe import BytePipe
from mirage.io.types import ByteSource

logger = logging.getLogger(__name__)


class ByteWriter:
    """Feed one consuming write through a bounded pipe.

    Args:
        consume (Callable): consumes the source once and commits at EOF.
    """

    def __init__(
        self, consume: Callable[[ByteSource], Awaitable[None]]
    ) -> None:
        self.pipe = BytePipe()
        self.task = asyncio.create_task(self._run(consume))

    async def _run(
        self, consume: Callable[[ByteSource], Awaitable[None]]
    ) -> None:
        try:
            await consume(self.pipe.stream())
        finally:
            self.pipe.close_reader()

    async def write(self, data: bytes) -> None:
        try:
            await self.pipe.write(data)
        except PipeClosed:
            await self.task
            raise

    async def finish(self) -> None:
        self.pipe.end()
        await self.task

    async def abort(self) -> None:
        self.task.cancel()
        self.pipe.close_reader()
        try:
            await self.task
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.debug("aborted write failed: %s", exc)
