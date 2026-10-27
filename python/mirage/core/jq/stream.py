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

# Follows jq 1.8.2's src/util.c (MIT; see licenses/third_party/jq.txt).

from collections.abc import AsyncIterator, Callable, Sequence

from mirage.core.jq.parse import (
    JqParser,
    decode_utf8,
    string_text,
    utf8_missing,
)
from mirage.core.jq.types import (
    NO_VALUE,
    UNKNOWN_POSITION,
    InputSource,
    JqOptions,
    JqParseError,
    NoValue,
)
from mirage.errors.constants import FS_ERRORS, READ_FAILURES
from mirage.errors.fs import fs_strerror

# The most bytes one read of jq's input reader takes (jq 1.8.2's util.c):
# fgets into a 4096-byte buffer, less the four bytes it keeps for UTF-8
# and the NUL. A read stops after a newline, and one that ends inside a
# character reads on to the end of it.
READ_CHUNK = 4091

WHITESPACE = b" \t\r\n"


class InputReader:
    """jq's input reader (util.c) over every input of an invocation.

    One parser reads all of them, one after another, so a value can run
    on from one input into the next the way it does in jq (`1` then `2`
    read as `12`), and a parse error counts its lines across the inputs.
    The parser is fed the pieces jq's fgets reads, so the position a run
    reports, the input's name and the lines read of it, is jq's. Under -R
    the pieces make up the lines, which also run on from one input into
    the next when one lacks its final newline.

    Each value comes out as original JSON text or literal-preserving
    streaming event text from the shared scanner.

    An input is opened when the reader reaches it, and one that cannot be
    opened or read is reported and counted the way jq's reader does it,
    and the reader moves on to the next (see _fail). Without `report`,
    such an error propagates instead.

    Args:
        sources (Sequence[InputSource]): the inputs, in order.
        opts (JqOptions): resolved options; -R, -s, --seq and --stream
            decide how the inputs are read.
        report (Callable[[str], None] | None): takes each line jq's reader
            writes to stderr about an input it could not open or read.
    """

    def __init__(
        self,
        sources: Sequence[InputSource],
        opts: JqOptions,
        report: Callable[[str], None] | None = None,
    ) -> None:
        self._sources = list(sources)
        self._report = report
        self._failed_inputs = 0
        self._opened = 0
        self._parser = (
            None
            if opts.raw_input
            else JqParser(seq=opts.seq, streaming=opts.stream)
        )
        self._json_eof = False
        self._slurped: "list[str] | str | NoValue" = NO_VALUE
        if opts.slurp:
            self._slurped = "" if opts.raw_input else []
        self._name: str | None = None
        self._line = 0
        self._chunks: AsyncIterator[bytes] | None = None
        self._pending = bytearray()
        self._drained = False
        self._feof = False
        self._fresh = True
        self._failed = False

    def failures(self) -> int:
        """How many inputs could not be opened or read, which jq's main
        loop checks before it reads each document
        (jq_util_input_errors)."""
        return self._failed_inputs

    def position(self) -> str:
        """Where jq's reader stands, as its error reports word it: the
        current input and the lines read of it, or `<unknown>` before any
        input was opened."""
        if self._name is None:
            return UNKNOWN_POSITION
        return f"{self._name}:{self._line}"

    def filename(self) -> str | None:
        """The input the reader reads, None before it opened one, which
        `input_filename` answers (jq_util_input_get_current_filename)."""
        return self._name

    def line_number(self) -> int:
        """The lines read of the current input, which `input_line_number`
        answers (jq_util_input_get_current_line)."""
        return self._line

    async def close(self) -> None:
        """Close the input the reader stopped in, as jq's exit closes its
        file: a parse error, a halt, or a program that takes one `input`
        leaves it part read, and left to the garbage collector its
        backend stream stays open until a collection finds it."""
        chunks, self._chunks = self._chunks, None
        close = getattr(chunks, "aclose", None)
        try:
            if close is not None:
                await close()
        finally:
            if self._parser is not None:
                await self._parser.close()

    async def next_input(self) -> "str | JqParseError | NoValue":
        """The JSON text of the next value of the stream, the parse error
        that stops it, or NO_VALUE once it is used up
        (jq_util_input_next_input). Under -s the one value is the whole
        stream; a parse error comes back instead of it."""
        if self._parser is None:
            return await self._next_line()
        parser = self._parser
        while True:
            value = await parser.next()
            if isinstance(value, JqParseError):
                return value
            if value is not NO_VALUE:
                if not isinstance(self._slurped, list):
                    return value
                self._slurped.append(value)
                continue
            if self._json_eof:
                break
            piece, self._json_eof = await self._read_more()
            parser.feed(piece, not self._json_eof)
        return self._take_slurped()

    async def _next_line(self) -> "str | NoValue":
        line: str | NoValue = NO_VALUE
        while True:
            piece, is_last = await self._read_more()
            if piece:
                if isinstance(self._slurped, str):
                    self._slurped += await decode_utf8(piece)
                elif piece.endswith(b"\n"):
                    head = "" if line is NO_VALUE else line
                    return string_text(head + (await decode_utf8(piece[:-1])))
                else:
                    line = (
                        "" if line is NO_VALUE else line
                    ) + await decode_utf8(piece)
            if is_last:
                break
        if isinstance(self._slurped, str):
            return self._take_slurped()
        return line if line is NO_VALUE else string_text(line)

    def _take_slurped(self) -> "str | NoValue":
        slurped = self._slurped
        self._slurped = NO_VALUE
        if isinstance(slurped, list):
            return f"[{','.join(slurped)}]"
        return slurped if slurped is NO_VALUE else string_text(slurped)

    async def _open_next(self) -> None:
        """Move on to the next input once the current one is read to its
        end, the first half of jq's read_more."""
        if self._chunks is not None and not self._feof:
            return
        self._chunks = None
        if self._opened < len(self._sources):
            source = self._sources[self._opened]
            self._opened += 1
            self._name = source.name
            self._line = 0
            self._chunks = source.chunks
            self._pending = bytearray()
            self._drained = False
            self._feof = False
            self._fresh = True
            self._failed = False

    async def _pull(self) -> None:
        assert self._chunks is not None
        try:
            chunk = await anext(self._chunks, None)
        except FS_ERRORS as exc:
            if self._report is None:
                raise
            self._fail(exc, self._report)
            return
        if chunk is None:
            self._drained = True
        else:
            self._pending += chunk
            self._fresh = self._fresh and not chunk

    def _fail(self, exc: OSError, report: Callable[[str], None]) -> None:
        """Count an input that could not be opened or read, and report it
        in the words of jq's reader: fopen's failure names the input, a
        failed read is the bare strerror. A directory opens, and fails at
        its first read. The input ends there, and the line fgets was
        reading when it failed is lost with it.

        Args:
            exc (OSError): the error.
            report (Callable[[str], None]): where the report goes.
        """
        strerror = fs_strerror(exc)
        if self._fresh and not isinstance(exc, READ_FAILURES):
            report(
                f"jq: error: Could not open file {self._name}: {strerror}\n"
            )
        else:
            report(f"jq: error: {strerror}\n")
        self._failed_inputs += 1
        self._failed = True
        self._drained = True

    async def _read_more(self) -> tuple[bytes, bool]:
        """jq's read_more: the next piece of the input, and whether the
        stream is used up, which a piece comes back empty for."""
        await self._open_next()
        piece = b""
        if self._chunks is not None:
            piece = await self._read_piece()
        return piece, self._opened == len(
            self._sources
        ) and self._chunks is None

    async def _read_piece(self) -> bytes:
        pending = self._pending
        while True:
            newline = pending.find(b"\n", 0, READ_CHUNK)
            if newline >= 0:
                piece = bytes(pending[: newline + 1])
                del pending[: newline + 1]
                self._line += 1
                return piece
            if len(pending) >= READ_CHUNK:
                piece = bytes(pending[:READ_CHUNK])
                del pending[:READ_CHUNK]
                missing = utf8_missing(piece)
                while missing and len(pending) < missing and not self._drained:
                    await self._pull()
                if missing:
                    piece += bytes(pending[:missing])
                    del pending[:missing]
                return piece
            if self._drained:
                piece = b"" if self._failed else bytes(pending)
                pending.clear()
                self._feof = True
                return piece
            await self._pull()


async def read_texts(
    source: InputSource,
) -> tuple[list[str], JqParseError | None]:
    """The JSON text of every value of one input, and the parse error that
    ended it early, as jq reads a --slurpfile.

    Args:
        source (InputSource): the input.
    """
    reader = InputReader([source], JqOptions())
    texts: list[str] = []
    try:
        while True:
            text = await reader.next_input()
            if isinstance(text, JqParseError):
                return texts, text
            if text is NO_VALUE:
                return texts, None
            texts.append(text)
    finally:
        await reader.close()


async def value_text(text: bytes) -> "str | NoValue":
    """The JSON text of the one value a text holds, as jq's jv_parse reads
    an --argjson or a --jsonargs value, or NO_VALUE when it holds none,
    several, or bad JSON.

    Args:
        text (bytes): the text.
    """
    parser = JqParser()
    try:
        parser.feed(text, False)
        value = await parser.next()
        if value is NO_VALUE or isinstance(value, JqParseError):
            return NO_VALUE
        if await parser.next() is not NO_VALUE:
            return NO_VALUE
        return value.strip(WHITESPACE.decode())
    finally:
        await parser.close()
