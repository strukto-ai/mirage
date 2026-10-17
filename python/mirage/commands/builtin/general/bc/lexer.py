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

import codecs
from collections.abc import AsyncGenerator

from mirage.io.cooperative import chunks
from mirage.io.types import ByteSource

from . import constants
from .types import BcStatement


def string_end(text: str, pos: int) -> int:
    """Where the string literal opening at `pos` ends.

    Args:
        text (str): the input the literal sits in.
        pos (int): the offset of the opening quote.

    Returns:
        int: the offset just past the closing quote, or -1 when the input
            holds no second quote. A backslash never escapes the closing
            quote, so a literal ending in one closes there and the text
            after it is ordinary tokens again.
    """
    close = text.find(constants.STRING_QUOTE, pos + 1)
    return -1 if close < 0 else close + 1


def unescape(text: str) -> str:
    """Expand the escapes `print` honours in a string literal's body.

    Args:
        text (str): the body, without its quotes.

    Returns:
        str: the characters `print` writes. An escape GNU has no rule for
            writes nothing, and so does a trailing backslash.
    """
    out: list[str] = []
    pos = 0
    while pos < len(text):
        char = text[pos]
        if char != "\\":
            out.append(char)
            pos += 1
            continue
        out.append(constants.PRINT_ESCAPES.get(text[pos + 1 : pos + 2], ""))
        pos += 2
    return "".join(out)


def all_blank(text: str) -> bool:
    """Whether `text` holds nothing but blanks.

    Args:
        text (str): the text to test.

    Returns:
        bool: True when every character is one a statement is trimmed of.
    """
    return all(char in constants.TRIM_CHARS for char in text)


def trim_piece(text: str, lines: list[int]) -> tuple[str, list[int]]:
    """Drop the blanks at both ends of a statement and its line map.

    Args:
        text (str): the statement source.
        lines (list[int]): the input line per character of `text`.

    Returns:
        tuple[str, list[int]]: the trimmed text and the matching slice of
            the line map, which has to stay the same length so an offset
            still names a line.
    """
    start = 0
    end = len(text)
    while start < end and text[start] in constants.TRIM_CHARS:
        start += 1
    while end > start and text[end - 1] in constants.TRIM_CHARS:
        end -= 1
    return text[start:end], lines[start:end]


def quit_offset(text: str) -> int:
    """Where GNU's lexer meets a `quit` token on one input line.

    `quit` is read by the lexer, which exits the moment it reaches one,
    so nothing later on that line is ever scanned and the line itself
    never runs. Only a whole identifier counts, which is why `quitx` is
    an ordinary variable, and a `quit` inside a number or a string
    literal is not one either.

    Args:
        text (str): one input line, comments already removed.

    Returns:
        int: the offset of the `quit`, or -1 when the line has none.
    """
    pos = 0
    while pos < len(text):
        char = text[pos]
        if char in constants.NAME_START:
            start = pos
            pos += 1
            while pos < len(text) and text[pos] in constants.NAME_CHARS:
                pos += 1
            if text[start:pos] == constants.QUIT_NAME:
                return start
        elif char in constants.NUMBER_CHARS:
            while pos < len(text) and text[pos] in constants.NUMBER_CHARS:
                pos += 1
        elif char == constants.STRING_QUOTE:
            # An unterminated quote is one illegal character and scanning
            # resumes right after it, so a `quit` behind one still ends
            # the run.
            end = string_end(text, pos)
            pos = pos + 1 if end < 0 else end
        else:
            pos += 1
    return -1


def cut_at_quit(text: str, lines: list[int]) -> tuple[str, list[int], bool]:
    """Trim one input line at the `quit` its lexer would exit on.

    GNU hands `quit` to the parser, which ends the run on it as a whole
    statement and refuses it anywhere else, so the keyword is kept when
    something precedes it in its own statement (`1 quit` is a syntax
    error) and dropped when nothing does (`1+1;quit` is silent).

    Args:
        text (str): one input line, comments already removed.
        lines (list[int]): the input line per character of `text`.

    Returns:
        tuple[str, list[int], bool]: the kept text, its line map, and
            whether the line quits.
    """
    cut = quit_offset(text)
    if cut < 0:
        return text, lines, False
    head = text[:cut].rpartition(constants.STATEMENT_SEPARATOR)[2]
    end = cut if all_blank(head) else cut + len(constants.QUIT_NAME)
    return text[:end], lines[:end], True


def line_statements(
    text: str, lines: list[int], end_line: int
) -> tuple[list[BcStatement], bool]:
    """Split one input line into statements.

    Args:
        text (str): the line, comments already removed.
        lines (list[int]): the input line per character of `text`.
        end_line (int): the input line the terminating newline sits on.

    Returns:
        tuple[list[BcStatement], bool]: the statements, and whether a
            `quit` on this line ends the run.
    """
    text, lines, quits = cut_at_quit(text, lines)
    out: list[BcStatement] = []
    start = 0
    index = 0
    while index <= len(text):
        if index < len(text):
            char = text[index]
            # A `;` inside a string is content, not a separator, so the
            # whole token is stepped over before the next one is looked
            # for.
            if char == constants.STRING_QUOTE:
                end = string_end(text, index)
                index = index + 1 if end < 0 else end
                continue
            if char != constants.STATEMENT_SEPARATOR:
                index += 1
                continue
        piece, piece_lines = trim_piece(text[start:index], lines[start:index])
        if piece != "":
            # The token that follows decides where an incomplete
            # construct is charged: a `;` sits on the current line, while
            # a newline has already moved the counter on.
            incomplete = lines[index] if index < len(text) else end_line + 1
            out.append(
                BcStatement(piece, tuple(piece_lines), incomplete, not quits)
            )
        start = index + 1
        index += 1
    return out, quits


async def parse_input(
    source: ByteSource,
) -> AsyncGenerator[list[BcStatement] | str, None]:
    """Read bc's input into statements as it arrives, stripping its comments.

    `#` runs to the end of its line and leaves the newline in place, so
    the newline still terminates the statement and the line counter still
    advances -- which is what keeps a later diagnostic on the right line.
    A `/* */` comment becomes one space, so it separates tokens rather
    than vanishing (`1/*c*/2` is `1 2`), and the newlines inside one
    advance the counter without ending the statement. A string is neither:
    it is copied verbatim, so `"a#b"` keeps its hash and a string carrying
    a newline keeps the statement open across the line break.

    Args:
        source (ByteSource): the stdin, decoded as UTF-8 as it arrives.

    Yields:
        list[BcStatement] | str: the statements of each logical line, in
            order, or last ``EOF_IN_COMMENT`` when a block comment runs to
            the end of the input, which GNU reports and which discards the
            statements it was reading. The grouping is what GNU runs as
            one unit -- a whole `semicolon_list`, however many input lines
            a block comment stretched it over -- so a parse error anywhere
            in a group discards the whole group.
    """
    stream = chunks(source)
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    text = ""
    exhausted = False

    async def refill() -> None:
        nonlocal text, exhausted
        try:
            text += decoder.decode(await anext(stream))
        except StopAsyncIteration:
            text += decoder.decode(b"", final=True)
            exhausted = True

    async def more() -> bool:
        while pos >= len(text) and not exhausted:
            await refill()
        return pos < len(text)

    try:
        chars: list[str] = []
        char_lines: list[int] = []
        pos = 0
        line = 1
        while await more():
            char = text[pos]
            if char == constants.STRING_QUOTE:
                end = string_end(text, pos)
                while end < 0 and not exhausted:
                    await refill()
                    end = string_end(text, pos)
                if end > 0:
                    # The token is copied as it stands: a `#` or a `/*` in it
                    # is content, and a newline in it advances the counter
                    # without ending the logical line, so a diagnostic after
                    # a string that spans lines still names its own line.
                    for index in range(pos, end):
                        chars.append(text[index])
                        char_lines.append(line)
                        if text[index] == "\n":
                            line += 1
                    pos = end
                    continue
                # No closing quote anywhere: the parser reports this one as an
                # illegal character, and the rest of the input lexes as
                # usual, comments included.
            if char == constants.LINE_COMMENT:
                while await more() and text[pos] != "\n":
                    pos += 1
                continue
            if text[pos] == "/" and pos + 1 == len(text) and not exhausted:
                await refill()
            if text.startswith(constants.BLOCK_OPEN, pos):
                pos += len(constants.BLOCK_OPEN)
                while await more():
                    if (
                        text[pos] == "*"
                        and pos + 1 == len(text)
                        and not exhausted
                    ):
                        await refill()
                    if text.startswith(constants.BLOCK_CLOSE, pos):
                        break
                    if text[pos] == "\n":
                        line += 1
                    pos += 1
                if pos >= len(text):
                    yield constants.EOF_IN_COMMENT
                    return
                pos += len(constants.BLOCK_CLOSE)
                chars.append(" ")
                char_lines.append(line)
                continue
            if char == "\n":
                found, quits = line_statements(
                    "".join(chars), char_lines, line
                )
                if found:
                    yield found
                if quits:
                    return
                chars = []
                char_lines = []
                line += 1
                text = text[pos + 1 :]
                pos = 0
                continue
            chars.append(char)
            char_lines.append(line)
            pos += 1
        found, _ = line_statements("".join(chars), char_lines, line)
        if found:
            yield found
        return
    finally:
        await stream.aclose()
