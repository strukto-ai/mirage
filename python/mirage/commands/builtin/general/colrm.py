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

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.stream import resolve_source
from mirage.commands.config import Context, command
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.io.async_line_iterator import char_width, lead_width
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import utf8_locale
from mirage.types import PathSpec

BAD_CHARACTER = (
    b"colrm: fgetwc() failed: Invalid or incomplete multibyte or wide "
    b"character\n"
)
LONGEST_COLUMN = (1 << 63) - 1
TAB_STOP = 8


def _column_argument(word: str, which: str) -> tuple[int | None, bytes]:
    """A column operand, or what colrm says of it.

    Args:
        word (str): the operand.
        which (str): ``first`` or ``second``.
    """
    if not word.isascii() or not word.isdigit():
        line = f"colrm: {which} argument: '{quote_text(word)}'\n"
        return None, line.encode()
    value = int(word)
    if value > LONGEST_COLUMN:
        line = (
            f"colrm: {which} argument: '{quote_text(word)}': "
            "Numerical result out of range\n"
        )
        return None, line.encode()
    return value, b""


def _advance(column: int, char: bytes) -> int:
    """The column after one character.

    Args:
        column (int): the column before it.
        char (bytes): the character.
    """
    if char == b"\t":
        return (column + TAB_STOP) // TAB_STOP * TAB_STOP
    if char == b"\b":
        return max(column - 1, 0)
    return column + (1 if char >= b" " and char != b"\x7f" else 0)


def _is_valid_utf8(data: bytes) -> bool:
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return True


class _Line:
    """Where one line's characters stand against the columns removed."""

    def __init__(self, start: int, stop: int | None) -> None:
        self.start, self.stop = start, stop
        self.reset()

    def reset(self) -> None:
        self.column = 0
        self.phase = 0

    def take(self, char: bytes) -> bytes:
        """What one character of the line prints.

        Args:
            char (bytes): the character, its newline excluded.
        """
        if self.phase == 2:
            return char
        after = _advance(self.column, char)
        if self.phase == 0:
            if after <= self.start - 1:
                self.column = after
                return char
            padding = max(self.start - 1 - self.column, 0)
            self.column = after
            self.phase = 1
            return b" " * padding + self._past_stop()
        self.column = after
        return self._past_stop()

    def _past_stop(self) -> bytes:
        if self.stop is None or self.column < self.stop:
            return b""
        self.phase = 2
        return b" " * (self.column - self.stop)


async def _removed(
    source: AsyncIterator[bytes],
    start: int,
    stop: int | None,
    utf8: bool,
    io: IOResult,
) -> AsyncIterator[bytes]:
    line = _Line(start, stop)
    held = bytearray()
    async for chunk in source:
        held += chunk
        out = bytearray()
        at = 0
        while at < len(held):
            first = held[at]
            if first < 0x80:
                size = 1
            elif not utf8:
                size = 0
            else:
                size = char_width(held, at)
                if at + size == len(held) and size < lead_width(first):
                    break
                if not _is_valid_utf8(bytes(held[at : at + size])):
                    size = 0
            if size == 0:
                io.exit_code = 1
                io.stderr = BAD_CHARACTER
                if out:
                    yield bytes(out)
                return
            char = bytes(held[at : at + size])
            at += size
            if char == b"\n":
                line.reset()
                out += char
            else:
                out += line.take(char) if start else char
        del held[:at]
        if out:
            yield bytes(out)


@command("colrm", vfs=None, spec=SPECS["colrm"])
async def colrm(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Remove columns from standard input: a start and an optional stop,
    both from 1, a start of 0 removing nothing. Pinned against util-linux
    2.41.5.
    """
    start = 0
    stop: int | None = None
    if texts:
        first, said = _column_argument(texts[0], "first")
        if first is None:
            return None, IOResult(exit_code=1, stderr=said)
        start = first
    if len(texts) > 1:
        second, said = _column_argument(texts[1], "second")
        if second is None:
            return None, IOResult(exit_code=1, stderr=said)
        stop = second
    io = IOResult()
    utf8 = utf8_locale(ctx.env)
    source = resolve_source(ctx.stdin)
    return _removed(source, start, stop, utf8, io), io
