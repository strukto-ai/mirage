from collections.abc import AsyncIterator

from mirage.shell.console import Channel, JobConsole
from mirage.shell.console.pipe import PipeConsole
from mirage.shell.errors import PipeClosed


class ProcessInput:

    def __init__(self) -> None:
        self.pipe = PipeConsole()
        self.closed = False

    async def write(self, data: bytes) -> None:
        if not data:
            return
        if self.closed:
            raise PipeClosed()
        for start in range(0, len(data), 65536):
            await self.pipe.emit(Channel.STDOUT, data[start:start + 65536])

    def close(self) -> None:
        self.closed = True
        self.pipe.end()

    def stop(self) -> None:
        self.close()
        self.pipe.close_reader()

    def stream(self) -> AsyncIterator[bytes]:
        return self.pipe.stream()


class ProcessOutput(JobConsole):

    def __init__(self) -> None:
        super().__init__()
        self.stdout = ProcessInput()
        self.stderr = ProcessInput()

    async def emit(self, channel: Channel, data: bytes) -> None:
        target = self.stderr if channel == Channel.STDERR else self.stdout
        await target.write(data)

    def end(self) -> None:
        self.stdout.close()
        self.stderr.close()

    def stop(self) -> None:
        self.stdout.stop()
        self.stderr.stop()
