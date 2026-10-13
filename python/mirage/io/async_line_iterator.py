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
from collections.abc import AsyncGenerator

from mirage.io.cooperative import chunks
from mirage.io.types import ByteSource, DeviceInput, PipeEnd, PipeStream
from mirage.io.yield_budget import YieldBudget
from mirage.types import PathSpec


def char_width(data: bytes) -> int:
    """How many bytes ``data``'s first character spans, decoded as UTF-8.

    Always at least one and never more than what is there, so a caller
    stepping by this never splits a character and never stalls. Bytes
    that decode to one replacement character answer 1, which is what
    ``decode(errors="replace")`` makes of them: a stray continuation
    byte, a lead the encoding never uses, and a sequence cut short by a
    byte that cannot continue it.

    Args:
        data (bytes): the buffer, at least one byte.
    """
    lead = data[0]
    if lead < 0xC2 or lead >= 0xF5:
        return 1
    width = 2 if lead < 0xE0 else 3 if lead < 0xF0 else 4
    for i in range(1, min(width, len(data))):
        if not 0x80 <= data[i] < 0xC0:
            return i
    return min(width, len(data))


class PipeInput:
    """The read end an ``exec`` keeps on a live pipe (``exec 3<"$1"``).

    It holds the pipe it opened, not the name it was opened by, so a link
    removed since changes nothing. Each read takes a stream of its own,
    in the reading command's own task, and closes it after one chunk: a
    read that gives up (``timeout``) takes nothing with it, and the next
    read, through this descriptor or another, gets what it left. Once the
    substitution's command has ended the pipe, a read finds its end.

    Args:
        path (PathSpec): the pipe's own path (``/dev/fd/N``).
        end (PipeEnd): the pipe.
    """

    def __init__(self, path: PathSpec, end: PipeEnd) -> None:
        self.path = path
        self._end = end

    def __aiter__(self) -> "PipeInput":
        return self

    async def __anext__(self) -> bytes:
        stream = self._end.stream(self.path)
        try:
            return await anext(stream)
        finally:
            closer = getattr(stream, "aclose", None)
            if closer is not None:
                await closer()

    async def aclose(self) -> None:
        """Nothing stays open between reads."""


class AsyncLineIterator:
    def __init__(self, source: ByteSource) -> None:
        self._source: AsyncGenerator[bytes, None] | PipeInput = (
            source if isinstance(source, PipeInput) else chunks(source)
        )
        self._budget = YieldBudget()
        self._buf = b""
        self._loaded = 0
        self._exhausted = False
        self._view: bytes | None = None
        self._view_key: tuple[tuple[bytes, ...], bool] = ((), False)
        self._hits: list[int] = []
        self._unskipped = 0

    @property
    def position(self) -> int:
        return self._loaded - len(self._buf)

    async def _next_chunk(self) -> bytes:
        data = await self._source.__anext__()
        self._loaded += len(data)
        return data

    def __aiter__(self) -> "AsyncLineIterator":
        return self

    async def __anext__(self) -> bytes:
        line = await self.readline()
        if line is None:
            raise StopAsyncIteration
        return line

    async def readline(self, eol: bytes = b"\n") -> bytes | None:
        """Return next line (without its terminator), or None at EOF.

        Args:
            eol (bytes): the one-byte line terminator.
        """
        data, found = await self.read_until(eol)
        return data if found or data else None

    def buffered_lines(
        self,
        eol: bytes = b"\n",
        limit: int = 31,
        needles: tuple[bytes, ...] | None = None,
        ignore_case: bool = False,
    ) -> list[bytes]:
        """Peek at complete buffered records without pulling or consuming input.

        Args:
            eol (bytes): the one-byte record delimiter.
            limit (int): maximum records to return.
            needles (tuple[bytes, ...] | None): keep only the records that
                hold one, as ``skip_nonmatching_lines`` reads them; None
                keeps every record.
            ignore_case (bool): search an ASCII-lowercased view.
        """
        if needles is None:
            return self._buf.split(eol, limit)[:-1]
        kept: list[bytes] = []
        for record in self._buf.split(eol)[:-1]:
            view = record.lower() if ignore_case else record
            if any(needle in view for needle in needles):
                kept.append(record)
                if len(kept) == limit:
                    break
        return kept

    def skip_empty_lines(
        self, limit: int | None = None, eol: bytes = b"\n"
    ) -> int:
        """Consume buffered empty lines without pulling more input.

        Args:
            limit (int | None): maximum lines to consume, or all buffered.
            eol (bytes): the one-byte line terminator.
        """
        end = len(self._buf) if limit is None else min(limit, len(self._buf))
        count = 0
        while count < end and self._buf[count] == eol[0]:
            count += 1
        self._buf = self._buf[count:]
        return count

    def skip_nonmatching_lines(
        self,
        needles: tuple[bytes, ...],
        ignore_case: bool = False,
        delimiter: bytes = b"\n",
    ) -> tuple[int, int]:
        """Skip complete buffered records before a possible literal match.

        Leave the candidate and any unfinished record for ``read_until`` to
        join across transport boundaries. Never pull more input. Each
        needle's next hit is kept until the buffer is refilled, so the calls
        between two pulls search it once, however the hits interleave.

        Args:
            needles (tuple[bytes, ...]): one or more nonempty literals
                without the delimiter, lowercase under ``ignore_case``.
            ignore_case (bool): search an ASCII-lowercased view.
            delimiter (bytes): the one-byte record terminator.

        Returns:
            tuple[int, int]: skipped record and byte counts.
        """
        key = (needles, ignore_case)
        if self._view is None or self._view_key != key:
            self._view = self._buf.lower() if ignore_case else self._buf
            self._view_key = key
            self._hits = [-1] * len(needles)
            self._unskipped = 0
        # Dense matches skip nothing; stop trying until the next pull.
        if self._unskipped >= 8:
            return 0, 0
        view = self._view
        start = len(view) - len(self._buf)
        for index, needle in enumerate(needles):
            if self._hits[index] < start:
                found = view.find(needle, start)
                self._hits[index] = found if found >= 0 else len(view)
        end = self._buf.rfind(delimiter, 0, min(self._hits) - start) + 1
        self._unskipped = self._unskipped + 1 if end == 0 else 0
        count = self._buf.count(delimiter, 0, end)
        self._buf = self._buf[end:]
        return count, end

    async def read_until(self, delim: bytes) -> tuple[bytes, bool]:
        """Read up to (not including) ``delim``, or to EOF.

        Args:
            delim (bytes): the one-byte delimiter; ``b"\0"`` for NUL.

        Returns:
            tuple[bytes, bool]: the bytes read and whether the delimiter
            was found (False means EOF ended the read, which is what
            ``read`` reports as status 1).
        """
        if not delim:
            raise ValueError("empty separator")
        parts: list[bytes] = []
        try:
            await self._budget.run()
            while True:
                index = self._buf.find(delim)
                if index >= 0:
                    parts.append(self._buf[:index])
                    self._buf = self._buf[index + len(delim) :]
                    return b"".join(parts), True
                if self._exhausted:
                    parts.append(self._buf)
                    self._buf = b""
                    return b"".join(parts), False
                # Retain a possible delimiter prefix across source chunks.
                keep = min(len(delim) - 1, len(self._buf))
                split = len(self._buf) - keep
                parts.append(self._buf[:split])
                self._buf = self._buf[split:]
                try:
                    self._buf += await self._next_chunk()
                    self._view = None
                except StopAsyncIteration:
                    self._exhausted = True
        except BaseException as exc:
            if self._keeps_open(exc):
                self._buf = b"".join(parts) + self._buf
                raise
            await self._source.aclose()
            self._buf = b""
            self._exhausted = True
            raise

    def _keeps_open(self, exc: BaseException) -> bool:
        """Whether a read that ended with ``exc`` leaves the source open,
        what it had taken put back: a reader's own cancellation on a pipe
        an ``exec`` keeps, which the next reader goes on reading.

        Args:
            exc (BaseException): what ended the read.
        """
        return isinstance(self._source, PipeInput) and isinstance(
            exc, asyncio.CancelledError
        )

    async def read_chunk(self) -> bytes | None:
        """Hand over what is buffered, else the source's next chunk.

        Returns:
            bytes | None: the bytes, or None at end of input.
        """
        if self._buf:
            data, self._buf = self._buf, b""
            self._view = None
            return data
        if self._exhausted:
            return None
        try:
            await self._budget.run()
            return await self._next_chunk()
        except StopAsyncIteration:
            self._exhausted = True
            return None
        except BaseException as exc:
            if not self._keeps_open(exc):
                await self.discard()
            raise

    async def discard(self) -> None:
        """Close the source and drop what it buffered, for input a failed
        line abandoned."""
        self._buf = b""
        self._exhausted = True
        await self._source.aclose()

    async def load_rest(self) -> None:
        """Read what the source has left into the buffer, for a descriptor
        that outlives its source (a pipe whose substitution's command has
        ended): reads go on from memory, and the source's stream ends."""
        while not self._exhausted:
            try:
                await self._budget.run()
                chunk = await self._next_chunk()
            except StopAsyncIteration:
                self._exhausted = True
            else:
                self._buf += chunk
                self._view = None

    async def read_chars(
        self, count: int, delim: bytes | None
    ) -> tuple[bytes, bool]:
        """Read at most ``count`` characters, stopping early at ``delim``.

        ``read -n`` is "up to N characters or the delimiter, whichever
        first" and ``read -N`` is "exactly N, delimiters included", which
        is this with ``delim`` None. The delimiter is consumed and not
        returned.

        Characters, not bytes: bash counts them in the shell's locale, so
        ``read -n 1`` on ``éx`` assigns ``é`` and leaves ``x``. Counting
        bytes would hand back half a character and leave the other half
        to corrupt the next read. UTF-8 is the only encoding mirage
        decodes, so a byte that starts no valid sequence counts as one
        character on its own, which is what the replacement character it
        decodes to occupies.

        Args:
            count (int): how many characters to read.
            delim (bytes | None): the stop, or None to read through
                delimiters.

        Returns:
            tuple[bytes, bool]: the bytes read and whether the read
            ended on its own terms (the count reached, or the delimiter
            seen) rather than at EOF.
        """
        out = bytearray()
        try:
            taken = 0
            need = max(len(delim) if delim is not None else 1, 4)
            while taken < count:
                await self._budget.run()
                # One pull can split a character or a multibyte delimiter
                # across chunks, so top the buffer up to the widest either
                # could be before reading its first byte as a whole one.
                if len(self._buf) < need and not self._exhausted:
                    try:
                        self._buf += await self._next_chunk()
                        self._view = None
                    except StopAsyncIteration:
                        self._exhausted = True
                    continue
                if not self._buf:
                    return bytes(out), False
                if delim is not None and self._buf.startswith(delim):
                    self._buf = self._buf[len(delim) :]
                    return bytes(out), True
                width = char_width(self._buf)
                out += self._buf[:width]
                self._buf = self._buf[width:]
                taken += 1
            return bytes(out), True
        except BaseException as exc:
            if self._keeps_open(exc):
                self._buf = bytes(out) + self._buf
                raise
            await self._source.aclose()
            self._buf = b""
            self._exhausted = True
            raise


class SharedInput:
    """Standard input that the commands of one group, loop or shell read
    in turn, as bash's all read one open descriptor.

    What one command reads the next does not see again: ``read`` takes
    its line off ``lines`` and leaves the rest buffered there, and any
    other command iterates this object for that rest, then for what the
    source still holds. A command that stops early never closes the
    source, since a later command may still read it; whoever opened the
    source closes it, and a failed line discards it.

    One over a live pipe (a process substitution's ``/dev/fd/N``) names
    it in ``pipe`` while the substitution's command runs. When that
    command ends, its scope keeps the rest of the pipe readable for a
    descriptor the shell still holds (``f() { exec 3<"$1"; }; f <(cmd)``)
    and clears the name.

    Args:
        source (ByteSource | AsyncLineIterator): what the descriptor
            reads, or the line buffer of the descriptor it duplicates.
        pipe (PathSpec | None): the live pipe a duplicated descriptor
            reads; one built over a ``PipeStream`` takes that stream's.
    """

    def __init__(
        self,
        source: ByteSource | AsyncLineIterator,
        pipe: PathSpec | None = None,
    ) -> None:
        self.lines = (
            source
            if isinstance(source, AsyncLineIterator)
            else AsyncLineIterator(source)
        )
        self.pipe = (
            source.path
            if isinstance(source, (PipeStream, PipeInput))
            else pipe
        )

    def __aiter__(self) -> "SharedInput":
        return self

    def dup(self) -> "SharedInput":
        """Another descriptor on the same open file, as ``dup`` makes:
        a read through either moves the one offset."""
        return SharedInput(self.lines, self.pipe)

    async def __anext__(self) -> bytes:
        chunk = await self.lines.read_chunk()
        if chunk is None:
            raise StopAsyncIteration
        return chunk

    async def discard(self) -> None:
        """Close the source for good, for a line that failed reading it."""
        await self.lines.discard()


def share(stdin: ByteSource | None) -> ByteSource | None:
    """The one descriptor a construct hands every command it runs.

    ``< /dev/null`` stays as it is: it reads nothing, so there is no
    position to share, and its type tells a command no file is attached.

    Args:
        stdin (ByteSource | None): the construct's standard input.
    """
    if stdin is None or isinstance(stdin, (SharedInput, DeviceInput)):
        return stdin
    return SharedInput(stdin)


def line_buffer(stdin: ByteSource) -> AsyncLineIterator:
    """The line reader ``read``, ``mapfile`` and ``select`` take input
    from: a shared descriptor's own, so what they leave the next command
    reads, else one over ``stdin`` alone.

    Args:
        stdin (ByteSource): the command's standard input.
    """
    if isinstance(stdin, SharedInput):
        return stdin.lines
    return AsyncLineIterator(stdin)
