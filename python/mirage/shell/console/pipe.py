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

from collections.abc import AsyncIterator

from mirage.io.pipe import CAPACITY, BytePipe
from mirage.shell.console.job_console import JobConsole
from mirage.shell.console.types import Channel


class PipeConsole(JobConsole):
    """Route a shell's piped channels through the shared bounded byte pipe."""

    def __init__(
        self, pipe_stderr: bool = False, buffer_bytes: int = CAPACITY
    ) -> None:
        super().__init__()
        self._pipe_stderr = pipe_stderr
        self._pipe = BytePipe(buffer_bytes)

    async def emit(self, channel: Channel, data: bytes) -> None:
        if channel != Channel.STDOUT and not self._pipe_stderr:
            await super().emit(channel, data)
        else:
            await self._pipe.write(data)

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
        return self._pipe.stream()
