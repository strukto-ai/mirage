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

import re
from collections.abc import AsyncIterator, Callable, Sequence

import orjson

from mirage.core.jq.parse import (
    CLOSE_BRACE,
    CLOSE_BRACKET,
    OPEN_BRACE,
    QUOTE,
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

# The most bytes one read of jq's input reader takes (jq 1.8's util.c):
# fgets into a 4096-byte buffer, less the four bytes it keeps for UTF-8
# and the NUL. A read stops after a newline, and one that ends inside a
# character reads on to the end of it.
READ_CHUNK = 4091

WHITESPACE = b" \t\r\n"
CLOSERS = frozenset((QUOTE, CLOSE_BRACKET, CLOSE_BRACE))

# The line a pretty-printed document opens on, and the start of a line that
# is not indented: in such a document, the line it closes on.
OPENER_LINES = frozenset((b"[", b"{"))
UNINDENTED_LINE = re.compile(rb"\n[^ \t]")


def _parses(data: bytes) -> bool:
    """Whether orjson reads the text as one JSON value, which jq's parser
    then reads as one value too: what orjson refuses (jq's extra number
    forms, lone surrogates, invalid UTF-8, nesting past 1024) is jq's
    parser's to decide. Only the extent is orjson's to say; jq reads the
    text itself.

    Args:
        data (bytes): the text.
    """
    try:
        orjson.loads(data)
    except orjson.JSONDecodeError:
        return False
    return True


def _completion(data: bytes) -> int:
    """Where jq's parser holds the one value `data` spells whole: at its
    closing quote or bracket, or at the whitespace byte after a number or
    a literal. -1 for a number or a literal nothing follows, which jq
    completes only at the end of its input.

    Args:
        data (bytes): one value with the whitespace around it.
    """
    stop = len(data.rstrip(WHITESPACE))
    if data[stop - 1] in CLOSERS:
        return stop - 1
    return stop if stop < len(data) else -1


def pieces_through(data: bytes | bytearray, index: int) -> tuple[int, int]:
    """The reads jq's reader takes from the start of `data`, one piece at
    a time, until it holds byte `index`: where the last of them ends, and
    how many of them end in a newline, which is what its line count
    counts.

    Args:
        data (bytes | bytearray): an input's unread bytes, from a piece
            boundary on, through at least the piece holding `index`.
        index (int): the byte.
    """
    # A piece never runs past a newline, so each newline before the line
    # holding `index` ended a piece of its own.
    at = data.rfind(b"\n", 0, index) + 1
    lines = data.count(b"\n", 0, at)
    while True:
        newline = data.find(b"\n", at, at + READ_CHUNK)
        if newline >= 0:
            end = newline + 1
            lines += 1
        elif len(data) - at > READ_CHUNK:
            end = at + READ_CHUNK
            end = min(end + utf8_missing(data[at:end]), len(data))
        else:
            end = len(data)
        if end > index:
            return end, lines
        at = end


class InputReader:
    """jq's input reader (util.c) over every input of an invocation.

    One parser reads all of them, one after another, so a value can run
    on from one input into the next the way it does in jq (`1` then `2`
    read as `12`), and a parse error counts its lines across the inputs.
    The parser is fed the pieces jq's fgets reads, so the position a run
    reports, the input's name and the lines read of it, is jq's. Under -R
    the pieces make up the lines, which also run on from one input into
    the next when one lacks its final newline.

    Each value comes out as JSON text for libjq to read (JqParser.text):
    the bytes it was read from, so every number keeps its literal and
    every object its key order, which jq prints as they came in. A value
    orjson can read, one line of JSON Lines or a pretty-printed document,
    is taken in one step and handed to the parser as read (see _fast);
    everything else, bad input included, goes through jq's parser.

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
        self._fast_ok = not (opts.raw_input or opts.seq or opts.stream)
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

    async def close(self) -> None:
        """Close the input the reader stopped in, as jq's exit closes its
        file: a parse error, a halt, or a program that takes one `input`
        leaves it part read, and left to the garbage collector its
        backend stream stays open until a collection finds it."""
        chunks, self._chunks = self._chunks, None
        close = getattr(chunks, "aclose", None)
        if close is not None:
            await close()

    async def next_input(self) -> "str | JqParseError | NoValue":
        """The JSON text of the next value of the stream, the parse error
        that stops it, or NO_VALUE once it is used up
        (jq_util_input_next_input). Under -s the one value is the whole
        stream; a parse error comes back instead of it."""
        if self._parser is None:
            return await self._next_line()
        parser = self._parser
        is_last = False
        while True:
            if parser.remaining() == 0:
                if self._fast_ok and parser.clean():
                    fast = await self._fast(parser)
                    if fast is not NO_VALUE:
                        if not isinstance(self._slurped, list):
                            return fast
                        self._slurped.append(fast)
                        continue
                piece, is_last = await self._read_more()
                parser.feed(piece, not is_last)
            value = parser.next()
            if isinstance(value, JqParseError):
                return value
            if isinstance(self._slurped, list):
                if value is not NO_VALUE:
                    self._slurped.append(parser.text())
            elif value is not NO_VALUE:
                return parser.text()
            if is_last:
                break
        return self._take_slurped()

    async def _next_line(self) -> "str | NoValue":
        line: str | NoValue = NO_VALUE
        while True:
            piece, is_last = await self._read_more()
            if piece:
                if isinstance(self._slurped, str):
                    self._slurped += decode_utf8(piece)
                elif piece.endswith(b"\n"):
                    head = "" if line is NO_VALUE else line
                    return string_text(head + decode_utf8(piece[:-1]))
                else:
                    line = ("" if line is NO_VALUE else line) + decode_utf8(
                        piece
                    )
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

    async def _fast(self, parser: JqParser) -> "str | NoValue":
        """Take the next value's text in one step when orjson reads it as
        one value: the rest of the line, or else the pretty-printed
        document the line opens (see _document). The parser is handed the
        bytes as read and the rest of the last piece, so the line count,
        the position and whatever follows are what jq's parser would have
        reached.

        Args:
            parser (JqParser): the stream's parser, clean (JqParser.clean).
        """
        await self._open_next()
        if self._chunks is None:
            return NO_VALUE
        newline = self._pending.find(b"\n")
        while newline < 0 and not self._drained:
            searched = len(self._pending)
            await self._pull()
            newline = self._pending.find(b"\n", searched)
        pending = self._pending
        if not pending:
            return NO_VALUE
        skip = parser.bom_skip(bytes(pending[:3]))
        if skip is None:
            return NO_VALUE
        if newline < 0 and self._tail_unsettled():
            return NO_VALUE
        end = newline + 1 if newline >= 0 else len(pending)
        line = bytes(pending[skip:end])
        if _parses(line):
            stop = _completion(line)
            if stop < 0:
                return NO_VALUE
            return self._took(parser, skip, skip + stop)
        if line.rstrip(WHITESPACE) not in OPENER_LINES:
            return NO_VALUE
        return await self._document(parser, skip, end)

    async def _document(
        self, parser: JqParser, skip: int, start: int
    ) -> "str | NoValue":
        """Take a pretty-printed document in one step: one whose opener
        stands alone on the first line and whose closer starts a later
        line, every line between them indented.

        It reads on only to the first line that is not indented. The
        closer there completes the document, and anything else hands it
        to jq's parser. So it reads no further than jq's reader does
        before the document completes, and never past one document of a
        stream.

        Args:
            parser (JqParser): the stream's parser, clean.
            skip (int): the BOM bytes before the opener.
            start (int): where the opener's line ends.
        """
        pending = self._pending
        closer = CLOSE_BRACE if pending[skip] == OPEN_BRACE else CLOSE_BRACKET
        at = start - 1
        found = UNINDENTED_LINE.search(pending, at)
        while found is None and not self._drained:
            at = max(at, len(pending) - 1)
            await self._pull()
            found = UNINDENTED_LINE.search(pending, at)
        if found is None or pending[found.end() - 1] != closer:
            return NO_VALUE
        stop = found.end() - 1
        newline = pending.find(b"\n", stop)
        while newline < 0 and not self._drained:
            searched = len(pending)
            await self._pull()
            newline = pending.find(b"\n", searched)
        if newline < 0 and self._tail_unsettled():
            return NO_VALUE
        if not _parses(bytes(pending[skip : stop + 1])):
            return NO_VALUE
        return self._took(parser, skip, stop)

    def _tail_unsettled(self) -> bool:
        # Whether an input's bytes after its last newline cannot be taken
        # as they are: another input can run on from them, and a failed
        # read loses them.
        return self._failed or self._opened < len(self._sources)

    def _took(self, parser: JqParser, skip: int, stop: int) -> str:
        # The value's text: what `stop` completes, whitespace around it
        # left out (orjson read it as valid UTF-8).
        pending = self._pending
        end, lines = pieces_through(pending, stop)
        text = bytes(pending[skip : stop + 1]).strip(WHITESPACE).decode()
        parser.skip(pending, skip, stop + 1)
        rest = bytes(pending[stop + 1 : end])
        del pending[:end]
        self._line += lines
        parser.feed(rest, True)
        return text


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
    while True:
        text = await reader.next_input()
        if isinstance(text, JqParseError):
            return texts, text
        if text is NO_VALUE:
            return texts, None
        texts.append(text)


def value_text(text: bytes) -> "str | NoValue":
    """The JSON text of the one value a text holds, as jq's jv_parse reads
    an --argjson or a --jsonargs value, or NO_VALUE when it holds none,
    several, or bad JSON.

    Args:
        text (bytes): the text.
    """
    if _parses(text):
        return text.strip(WHITESPACE).decode()
    parser = JqParser()
    parser.feed(text, False)
    parsed = parser.next()
    if parsed is NO_VALUE or isinstance(parsed, JqParseError):
        return NO_VALUE
    value = parser.text()
    if parser.next() is not NO_VALUE:
        return NO_VALUE
    return value
