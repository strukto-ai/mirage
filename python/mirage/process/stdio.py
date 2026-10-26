from collections.abc import AsyncIterator

from mirage.io.errors import PipeClosed
from mirage.io.pipe import CAPACITY, BytePipe
from mirage.io.stream import OutputStream
from mirage.shell.console import Channel, JobConsole
from mirage.types import Refusal


class ProcessInput:
    def __init__(self, capacity: int = CAPACITY) -> None:
        self.pipe = BytePipe(capacity)
        self.closed = False
        self.bytes_read = 0

    async def write(self, data: bytes) -> None:
        if not data:
            return
        if self.closed:
            raise PipeClosed()
        await self.pipe.write(data)

    def close(self) -> None:
        self.closed = True
        self.pipe.end()

    def stop(self) -> None:
        self.close()
        self.pipe.close_reader()

    async def _read(self) -> AsyncIterator[bytes]:
        async for chunk in self.pipe.stream():
            self.bytes_read += len(chunk)
            yield chunk

    def stream(self) -> OutputStream:
        async def stop() -> None:
            self.stop()

        return OutputStream(self._read(), stop)


class ProcessOutput(JobConsole):
    def __init__(
        self, merge_stderr: bool = False, buffer_bytes: int = CAPACITY
    ) -> None:
        super().__init__()
        self.merge_stderr = merge_stderr
        self.stdout = ProcessInput(buffer_bytes)
        self.stderr = ProcessInput(buffer_bytes)
        self.refusal: Refusal | None = None

    async def emit(self, channel: Channel, data: bytes) -> None:
        target = (
            self.stderr
            if channel == Channel.STDERR and not self.merge_stderr
            else self.stdout
        )
        await target.write(data)

    def end(self) -> None:
        self.stdout.close()
        self.stderr.close()

    def stop(self) -> None:
        self.stdout.stop()
        self.stderr.stop()
