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

from mirage.shell.console.ram import RAMConsoleStore
from mirage.shell.console.store import ConsoleStore
from mirage.shell.console.types import Channel, ConsoleChunk, ReadResult


class JobConsole:
    """Everything one job has printed, readable from any position.

    A job writes here as it runs, and any number of readers consume at
    their own pace. A reader's whole state is one integer, so readers
    cost nothing, may join late, and may disappear without the console
    noticing.

    Args:
        store (ConsoleStore | None): where chunks live. Defaults to
            memory, which is the right home whenever the job and its
            readers share a process.
        finished (bool): whether the job has already ended, set when
            rebuilding a finished console from a snapshot.
    """

    def __init__(self,
                 store: ConsoleStore | None = None,
                 finished: bool = False) -> None:
        self._store = store if store is not None else RAMConsoleStore()
        self._finished = finished

    @property
    def finished(self) -> bool:
        """Whether this process has seen the job end.

        Reflects the CONTROL chunk this console wrote or restored. With a
        shared store, a job ended by another process is observed by
        reading, not through this flag.
        """
        return self._finished

    async def emit(self, channel: Channel, data: bytes) -> None:
        """Append output produced by the job.

        Ignored once the job has ended, so a runner still unwinding after
        a kill cannot append past the ending chunk and strand readers
        that already stopped following.

        Args:
            channel (Channel): which stream the bytes came from.
            data (bytes): the payload.
        """
        if self._finished:
            return
        await self._store.append(channel, data)

    async def finish(self, outcome: str) -> None:
        """Record how the job ended and release every waiting reader.

        Idempotent, so a job killed while it was already exiting does not
        get two endings.

        Args:
            outcome (str): ``exit:<code>`` or ``killed``.
        """
        if self._finished:
            return
        self._finished = True
        await self._store.append(Channel.CONTROL, outcome.encode())

    async def read_from(self,
                        seq: int,
                        limit: int | None = None) -> ReadResult:
        """Read chunks at or after a cursor.

        Args:
            seq (int): cursor to read from.
            limit (int | None): most chunks to return, or None for all.
        """
        return await self._store.read_from(seq, limit)

    async def follow(self, seq: int = 0) -> AsyncIterator[ConsoleChunk]:
        """Yield chunks as they arrive, ending when the job does.

        Ends on a closed store as well as on the job's ending chunk: a
        discarded console will never produce either, and waking once
        would only send this loop back to waiting.

        Args:
            seq (int): cursor to start from. The default replays the
                console from the beginning.
        """
        while True:
            chunks, seq, _ = await self._store.read_from(seq)
            for chunk in chunks:
                yield chunk
                if chunk.channel == Channel.CONTROL:
                    return
            await self._store.wait(seq)
            if self._store.closed:
                return

    async def wait_finished(self) -> None:
        """Return once the job has ended.

        Safe to await from a different thread and event loop than the one
        running the job, which is what makes it the join point for kill
        and for ``wait``. Returns on a closed store too, so a console
        discarded while someone was joining on it does not strand them.
        """
        seq = 0
        while True:
            chunks, seq, _ = await self._store.read_from(seq)
            if any(c.channel == Channel.CONTROL for c in chunks):
                return
            await self._store.wait(seq)
            if self._store.closed:
                return

    async def snapshot(self, channel: Channel | None = None) -> bytes:
        """Join everything the job has printed so far.

        Args:
            channel (Channel | None): restrict to one stream. The default
                joins stdout and stderr in the order they were produced,
                and omits the CONTROL chunk, which is status rather than
                output.
        """
        chunks, _, _ = await self._store.read_from(0)
        if channel is None:
            return b"".join(c.data for c in chunks
                            if c.channel != Channel.CONTROL)
        return b"".join(c.data for c in chunks if c.channel == channel)

    async def close(self) -> None:
        """Release the underlying store."""
        await self._store.close()
