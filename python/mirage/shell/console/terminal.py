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

import asyncio
from collections import deque
from collections.abc import Awaitable, Callable
from typing import Any

from mirage.concurrency.limiter import owned_task
from mirage.io.cooperative import CHUNK_SIZE
from mirage.shell.console.job_console import JobConsole
from mirage.shell.console.types import Channel, OwnedStream


class Terminal(JobConsole):
    """A shell's screen: what its lines and its background jobs wrote,
    in the order it arrived, until a line takes it.

    A line writes here through the sink it runs with, a background job
    through ``jobs``, the line's own ``JobOutput``. A job that writes
    while no line runs waits here for the next one, as bash's job prints
    to the terminal whenever it likes. With a reader attached (a caller
    streaming the line), every chunk goes straight on to it. A session
    has one (``tty``), shared by every fork of it.
    """

    def __init__(self) -> None:
        super().__init__()
        self.chunks: deque[tuple[Channel, bytes, bool]] = deque()
        self.reader: JobConsole | None = None
        self.jobs = JobOutput(JobSide(self))
        self.ended = 0
        self.attaching: asyncio.Event | None = None
        self._prefix = bytearray()
        self._draining: asyncio.Task[None] | None = None

    @property
    def stdout_prefix(self) -> bytes:
        """A bounded prefix of stdout handed to the current line's reader."""
        return bytes(self._prefix)

    def _remember(self, channel: Channel, data: bytes) -> None:
        if channel == Channel.STDOUT:
            self._prefix.extend(data[: max(0, CHUNK_SIZE - len(self._prefix))])

    async def emit(self, channel: Channel, data: bytes) -> None:
        """Take what the line wrote.

        Args:
            channel (Channel): stdout or stderr.
            data (bytes): the bytes.
        """
        await self.put(channel, data, False)

    async def put(self, channel: Channel, data: bytes, job: bool) -> None:
        """Pass a chunk to the reader, or keep it for the line; while a
        reader takes what waited (``attach``), keep it and wait. What was
        handed back to an attached reader (``hand_over``) goes to it
        first, all of it even if the writer is cancelled meanwhile: the
        reader is the line's, not the writer's.

        Args:
            channel (Channel): stdout or stderr.
            data (bytes): the bytes.
            job (bool): whether a background job wrote it.
        """
        if not data:
            return
        reader = self.reader
        if reader is not None and not self.chunks:
            self._remember(channel, data)
            await reader.emit(channel, data)
            return
        self.chunks.append((channel, data, job))
        if reader is not None:
            self.reader = None
            self._draining = owned_task(self._pass(reader))
            await asyncio.shield(self._draining)
        elif self.attaching is not None:
            await self.attaching.wait()

    async def attach(self, reader: JobConsole | None) -> None:
        """Start a line, handing a streaming caller what waited for it.

        The reader takes the chunks one at a time and becomes the line's
        only once none is left. A job that writes meanwhile lands behind
        what waited and waits until the reader is attached, so each
        writer adds at most one chunk and a noisy job cannot hold the
        line back; a line ended before that never attaches the reader.

        Args:
            reader (JobConsole | None): where the caller streams the line,
                None to collect it.
        """
        self._prefix.clear()
        if reader is None:
            self.reader = None
            return
        await self._pass(reader)

    async def _pass(self, reader: JobConsole) -> None:
        """Hand ``reader`` what waits, one chunk at a time, and make it
        the line's reader once none is left.

        Args:
            reader (JobConsole): where the caller streams the line.
        """
        ended = self.ended
        attaching = self.attaching = asyncio.Event()
        try:
            while self.chunks:
                channel, data, _ = self.chunks.popleft()
                self._remember(channel, data)
                await reader.emit(channel, data)
                if self.ended != ended:
                    return
            self.reader = reader
        finally:
            if self.attaching is attaching:
                self.attaching = None
            attaching.set()

    def hand_over(self, to: "Terminal") -> None:
        """Once its last line has ended, give ``to`` what is left here,
        ahead of what reached it meanwhile, and send there what jobs
        write from now on. A reader attached to ``to`` takes it before
        anything written after.

        Args:
            to (Terminal): the terminal that takes the rest.
        """
        to.chunks = self.chunks + to.chunks
        self.chunks = deque()
        self.reader = to.jobs

    def drain(self) -> tuple[bytes, bytes]:
        """What reached the terminal so far, stdout and stderr, taken out
        to be bounded and put back (``put_back``)."""
        chunks, self.chunks = self.chunks, deque()
        return (
            b"".join(d for c, d, _ in chunks if c == Channel.STDOUT),
            b"".join(d for c, d, _ in chunks if c == Channel.STDERR),
        )

    def put_back(self, out: bytes, err: bytes) -> None:
        """Return drained output ahead of whatever arrived meanwhile.

        Args:
            out (bytes): the stdout to return.
            err (bytes): the stderr to return.
        """
        returned = [
            (channel, data, False)
            for channel, data in ((Channel.STDOUT, out), (Channel.STDERR, err))
            if data
        ]
        self.chunks = deque(returned) + self.chunks

    def take(self) -> tuple[bytes, bytes]:
        """End a line: its stdout and stderr, jobs' output among them."""
        self._end()
        return self.drain()

    def drop_line(self) -> None:
        """End an abandoned line: what it wrote goes, its jobs' stays."""
        self.chunks = deque(chunk for chunk in self.chunks if chunk[2])
        self._end()

    def _end(self) -> None:
        """Detach the line's reader and let go the writers waiting on
        its attach."""
        self.reader = None
        self._prefix.clear()
        self.ended += 1
        if self.attaching is not None:
            self.attaching.set()
            self.attaching = None


class JobSide(JobConsole):
    """Where the background jobs write on a terminal.

    Args:
        terminal (Terminal): the terminal.
    """

    def __init__(self, terminal: Terminal) -> None:
        super().__init__()
        self.terminal = terminal

    async def emit(self, channel: Channel, data: bytes) -> None:
        """Take what a job wrote.

        Args:
            channel (Channel): stdout or stderr.
            data (bytes): the bytes.
        """
        await self.terminal.put(channel, data, True)


class JobOutput(JobConsole):
    """Where the background jobs one shell (a line, a subshell, a job,
    a substitution, a pipe stage) starts write.

    Into the statement that shell is running, among what the statement
    writes, so the two keep the order they were written in; when it runs
    none (between statements, or once it has ended), on to where the
    shell itself writes. A session's ``job_output`` is None in a typed
    line, whose jobs write through its terminal's ``jobs``.

    Args:
        target (JobConsole): where the shell writes.
    """

    def __init__(self, target: JobConsole) -> None:
        super().__init__()
        self.target = target
        self.recorder: JobConsole | None = None
        self._taken: list[JobConsole] = []
        self._tail: asyncio.Future[Any] | None = None
        self._turns = 0

    def hold_until(self, after: asyncio.Future[None]) -> None:
        """Keep what jobs write from now behind ``after``, in the order
        they write: a statement that stops recording them still lands
        what it recorded first.

        Args:
            after (asyncio.Future[None]): resolved once that has landed.
        """
        self._queue(
            after if self._tail is None else asyncio.gather(self._tail, after)
        )

    def _queue(self, turn: asyncio.Future[Any]) -> None:
        self._turns += 1
        self._tail = turn
        turn.add_done_callback(self._turned)

    def _turned(self, turn: asyncio.Future[Any]) -> None:
        self._turns -= 1
        if self._turns == 0:
            self._tail = None

    async def _in_turn(self, write: Callable[[], Awaitable[None]]) -> None:
        """Run ``write`` once every write queued before it has run.

        Args:
            write (Callable[[], Awaitable[None]]): the write.
        """
        before = self._tail
        done: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._queue(done)
        try:
            if before is not None:
                await asyncio.shield(before)
            await write()
        finally:
            if not done.done():
                done.set_result(None)

    def _destination(self) -> JobConsole:
        return self.recorder if self.recorder is not None else self.target

    def record(self, recorder: JobConsole) -> Callable[[], None]:
        """Send what jobs write into ``recorder`` until the returned call
        puts back what was there before.

        That call also ends every recording begun inside this one: a run
        its caller abandoned (timeout's) can end after the caller has, and
        then has nothing left to put back.

        Args:
            recorder (JobConsole): where jobs write meanwhile.
        """
        held = self.recorder
        depth = len(self._taken)
        self._taken.append(recorder)
        self.recorder = recorder

        def leave() -> None:
            if len(self._taken) <= depth or self._taken[depth] is not recorder:
                return
            del self._taken[depth:]
            self.recorder = held

        return leave

    async def emit(self, channel: Channel, data: bytes) -> None:
        """Write what a job wrote where it belongs now.

        Args:
            channel (Channel): stdout or stderr.
            data (bytes): the bytes.
        """
        if self._tail is None:
            await self._destination().emit(channel, data)
        else:
            await self._in_turn(
                lambda: self._destination().emit(channel, data)
            )

    async def emit_to(self, stream: OwnedStream, data: bytes) -> None:
        """Write what a job wrote to a stream a level owns, keeping the
        stream.

        Args:
            stream (OwnedStream): the stream the bytes were written to.
            data (bytes): the bytes.
        """
        if self._tail is None:
            await self._destination().emit_to(stream, data)
        else:
            await self._in_turn(
                lambda: self._destination().emit_to(stream, data)
            )

    def passes(
        self, streams: set[Channel | OwnedStream]
    ) -> set[Channel | OwnedStream]:
        """Which of the writes of the shell this leads to (``target``),
        or the streams above it, a job's streams reach: a shell passes
        them on as they are, a redirect (``JobRoute``) through its
        descriptors.

        Args:
            streams (set[Channel | OwnedStream]): what the job writes.
        """
        return set(streams)


class Tee(JobConsole):
    """A job's output, kept in its own console and copied to where the
    shell that started it writes.

    Args:
        console (JobConsole): the job's console.
        copy (JobConsole): where the shell writes.
    """

    def __init__(self, console: JobConsole, copy: JobConsole) -> None:
        super().__init__()
        self.console = console
        self.copy = copy

    async def emit(self, channel: Channel, data: bytes) -> None:
        """Write to both.

        Args:
            channel (Channel): stdout or stderr.
            data (bytes): the bytes.
        """
        await self.console.emit(channel, data)
        await self.copy.emit(channel, data)

    async def emit_to(self, stream: OwnedStream, data: bytes) -> None:
        """Write to both, the copy keeping the stream.

        Args:
            stream (OwnedStream): the stream the bytes were written to.
            data (bytes): the bytes.
        """
        await self.console.emit(stream.channel, data)
        await self.copy.emit_to(stream, data)
