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

    async def emit(self, channel: Channel, data: bytes) -> None:
        """Take what the line wrote.

        Args:
            channel (Channel): stdout or stderr.
            data (bytes): the bytes.
        """
        await self.put(channel, data, False)

    async def put(self, channel: Channel, data: bytes, job: bool) -> None:
        """Pass a chunk to the reader, or keep it for the line; while a
        reader takes what waited (``attach``), keep it and wait.

        Args:
            channel (Channel): stdout or stderr.
            data (bytes): the bytes.
            job (bool): whether a background job wrote it.
        """
        if not data:
            return
        if self.reader is not None:
            await self.reader.emit(channel, data)
            return
        self.chunks.append((channel, data, job))
        if self.attaching is not None:
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
        if reader is None:
            self.reader = None
            return
        ended = self.ended
        attaching = self.attaching = asyncio.Event()
        try:
            while self.chunks:
                channel, data, _ = self.chunks.popleft()
                await reader.emit(channel, data)
                if self.ended != ended:
                    return
            self.reader = reader
        finally:
            if self.attaching is attaching:
                self.attaching = None
            attaching.set()

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

    async def emit(self, channel: Channel, data: bytes) -> None:
        """Write what a job wrote where it belongs now.

        Args:
            channel (Channel): stdout or stderr.
            data (bytes): the bytes.
        """
        to = self.recorder if self.recorder is not None else self.target
        await to.emit(channel, data)

    async def emit_to(self, stream: OwnedStream, data: bytes) -> None:
        """Write what a job wrote to a stream a level owns, keeping the
        stream.

        Args:
            stream (OwnedStream): the stream the bytes were written to.
            data (bytes): the bytes.
        """
        to = self.recorder if self.recorder is not None else self.target
        await to.emit_to(stream, data)

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
