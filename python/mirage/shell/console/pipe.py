# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.io.memory import check_memory
from mirage.io.pipe import CAPACITY, BytePipe
from mirage.shell.console.job_console import JobConsole
from mirage.shell.console.types import Channel


class PipeConsole(JobConsole):
    """Route a shell's piped channels through the shared bounded byte pipe.

    Stderr that is not piped goes on to ``errors`` as it is written, as a
    pipeline stage's goes to the shell's own fd 2, or is kept here,
    checked against the workspace's memory, when there is none.

    Args:
        pipe_stderr (bool): stderr goes into the pipe too (``|&``).
        buffer_bytes (int): the pipe's capacity.
        gate (Callable[[], Awaitable[None]] | None): awaited before a
            write, to hold a paused job.
        errors (JobConsole | None): where stderr that is not piped goes.
    """

    def __init__(
        self,
        pipe_stderr: bool = False,
        buffer_bytes: int = CAPACITY,
        gate: Callable[[], Awaitable[None]] | None = None,
        errors: JobConsole | None = None,
    ) -> None:
        super().__init__()
        self._pipe_stderr = pipe_stderr
        self._pipe = BytePipe(buffer_bytes, gate)
        self._errors = errors
        self._held = 0

    async def emit(self, channel: Channel, data: bytes) -> None:
        if channel == Channel.STDOUT or self._pipe_stderr:
            await self._pipe.write(data)
        elif channel == Channel.STDERR and self._errors is not None:
            await self._errors.emit(channel, data)
        else:
            if channel == Channel.STDERR:
                self._held += len(data)
                check_memory(self._held)
            await super().emit(channel, data)

    def pipe_for(self, channel: Channel) -> BytePipe | None:
        return (
            self._pipe
            if channel == Channel.STDOUT or self._pipe_stderr
            else None
        )

    async def drain(self) -> None:
        await self._pipe.drain()

    @property
    def closed_reader(self) -> bool:
        return self._pipe.closed_reader

    def end(self, error: BaseException | None = None) -> None:
        self._pipe.end(error)

    def close_reader(self) -> None:
        self._pipe.close_reader()

    def stream(self) -> AsyncIterator[bytes]:
        return self._pipe.stream(joined=True)
