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

# Follows jq 1.8.2's src/jv_parse.c, with the UTF-8 decoding of its
# src/jv.c, src/jv_unicode.c and src/jv_utf8_tables.h (MIT; see
# licenses/third_party/jq.txt).

import json
import logging
import re
from enum import Enum, auto

from mirage.core.jq.types import (
    NO_VALUE,
    JqParseError,
    NoValue,
    NumberText,
    ParsedValue,
)

logger = logging.getLogger(__name__)

# The deepest jq nests arrays, objects and the keys between them. jq's
# streaming parser has no limit, but every event it hands out copies its
# path, so input nested n deep costs time in n squared: mirage holds it
# to this depth as well.
MAX_PARSING_DEPTH = 10000
DEPTH_EXCEEDED = "Exceeds depth limit for parsing"

UTF8_BOM = b"\xef\xbb\xbf"
BOM_DONE = len(UTF8_BOM)
# Where the BOM check stands once a BOM prefix met the wrong byte.
BOM_MALFORMED = 0xFF

RS = 0x1E
NEWLINE = 0x0A
QUOTE = 0x22
BACKSLASH = 0x5C
APOSTROPHE = 0x27
LOWER_N = 0x6E
LOWER_U = 0x75
OPEN_BRACKET = 0x5B
CLOSE_BRACKET = 0x5D
OPEN_BRACE = 0x7B
CLOSE_BRACE = 0x7D
COLON = 0x3A
COMMA = 0x2C
WHITESPACE = frozenset(b" \t\r\n")
STRUCTURE = frozenset(b"[,]{:}")
# What stands between two values of a stream: whitespace, and under --seq
# the RS before each one.
SEPARATORS = b" \t\r\n\x1e"

# Runs of bytes that each go through jq's scan() the same way, so a run
# is taken in one step: a literal's bytes, whitespace, a string's body.
LITERAL_RUN = re.compile(rb'[^ \t\r\n"\[,\]{:}]+')
LITERAL_RUN_SEQ = re.compile(rb'[^ \t\r\n"\[,\]{:}\x1e]+')
WHITESPACE_RUN = re.compile(rb"[ \t\r\n]+")
STRING_RUN = re.compile(rb'[^"\\]+')
STRING_RUN_SEQ = re.compile(rb'[^"\\\x1e]+')
CONTROL = re.compile(rb"[\x00-\x1f]")

# What decNumber reads as a number: jq accepts a sign, a bare dot, leading
# zeros, Infinity and NaN, where JSON does not.
DECIMAL = re.compile(rb"[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
INTEGER = re.compile(rb"[+-]?[0-9]+")
INFINITY = re.compile(rb"[+-]?(?:inf|infinity)", re.IGNORECASE)
NAN = re.compile(rb"[+-]?s?nan0*", re.IGNORECASE)

ESCAPES = {
    ord("\\"): b"\\",
    ord('"'): b'"',
    ord("/"): b"/",
    ord("b"): b"\b",
    ord("f"): b"\f",
    ord("t"): b"\t",
    ord("n"): b"\n",
    ord("r"): b"\r",
}

# jq's UTF-8 tables (jv_utf8_tables.h): how long a sequence each lead
# byte starts (0 for a byte no sequence starts with, CONTINUATION for a
# continuation byte), and the first code point each length may encode.
CONTINUATION = 0xFF
CODING_LENGTH = bytes(
    [1] * 0x80
    + [CONTINUATION] * 0x40
    + [0] * 2
    + [2] * 30
    + [3] * 16
    + [4] * 5
    + [0] * 11
)
FIRST_CODE_POINT = (0, 0, 0x80, 0x800, 0x10000)
REPLACEMENT = "\N{REPLACEMENT CHARACTER}"

EXPECTED_SEPARATOR = "Expected separator between values"
SURROGATE_PAIR = "Invalid \\uXXXX\\uXXXX surrogate pair escape"
CONTROL_CHARACTER = (
    "Invalid string: control characters from U+0000 "
    "through U+001F must be escaped"
)


class ParseState(Enum):
    """Where jq's scanner stands: between tokens, inside a string, just
    after a backslash in one, or skipping to the next RS under --seq."""

    NORMAL = auto()
    STRING = auto()
    STRING_ESCAPE = auto()
    WAITING_FOR_RS = auto()


class LastSeen(Enum):
    """The last thing jq's streaming parser read, which decides what may
    come next."""

    NONE = auto()
    OPEN_ARRAY = auto()
    OPEN_OBJECT = auto()
    COLON = auto()
    COMMA = auto()
    VALUE = auto()


class Scanned(Enum):
    """scan() producing an output, which jq signals with a message of its
    own rather than an error."""

    OUTPUT = auto()


def decode_utf8(data: bytes) -> str:
    """Decode bytes the way jq builds a string from them: a sequence that
    is not valid UTF-8 (a stray byte, an overlong form, an encoded
    surrogate, one past U+10FFFF, or one cut short) turns into a single
    U+FFFD (jv.c's jvp_string_copy_replace_bad over jvp_utf8_next).

    Args:
        data (bytes): the raw bytes.
    """
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        pass
    out: list[str] = []
    i = 0
    end = len(data)
    while i < end:
        first = data[i]
        if first < 0x80:
            out.append(chr(first))
            i += 1
            continue
        length = CODING_LENGTH[first]
        if length in (0, CONTINUATION):
            out.append(REPLACEMENT)
            i += 1
            continue
        if length > end - i:
            out.append(REPLACEMENT)
            break
        point = first & (0xFF >> (length + 1))
        taken = length
        for k in range(1, length):
            byte = data[i + k]
            if CODING_LENGTH[byte] != CONTINUATION:
                point = -1
                taken = k
                break
            point = (point << 6) | (byte & 0x3F)
        if (
            point < FIRST_CODE_POINT[length]
            or 0xD800 <= point <= 0xDFFF
            or point > 0x10FFFF
        ):
            out.append(REPLACEMENT)
        else:
            out.append(chr(point))
        i += taken
    return "".join(out)


def utf8_missing(piece: bytes | bytearray) -> int:
    """How many bytes would finish the UTF-8 character a piece ends in
    (jv_unicode.c's jvp_utf8_backtrack): 0 when it ends whole, or on a
    byte no sequence explains.

    Args:
        piece (bytes | bytearray): the bytes read so far, at least one.
    """
    i = len(piece) - 1
    if i == 0:
        return 0
    seen = 1
    while CODING_LENGTH[piece[i]] == CONTINUATION:
        if i == 0:
            break
        i -= 1
        seen += 1
    length = CODING_LENGTH[piece[i]]
    if length in (0, CONTINUATION) or length < seen:
        return 0
    return length - seen


def number_value(literal: bytes) -> int | float | NoValue:
    """The number a literal token spells, as decNumber reads it, or
    NO_VALUE when it spells none. jq takes NaN only with no payload
    digits other than zeros.

    Args:
        literal (bytes): the token, up to its first NUL.
    """
    if INTEGER.fullmatch(literal):
        try:
            return int(literal)
        except ValueError as exc:
            # Past the digits CPython converts to an int; the nearest
            # double stands in, as it does on the TypeScript host.
            logger.debug("jq: integer literal read as a double: %s", exc)
            return float(literal)
    if DECIMAL.fullmatch(literal):
        return float(literal)
    if INFINITY.fullmatch(literal):
        return float("-inf") if literal.startswith(b"-") else float("inf")
    if NAN.fullmatch(literal):
        return float("nan")
    return NO_VALUE


def string_text(value: str) -> str:
    """A string as JSON text, which jq's parser reads back as that string.

    Args:
        value (str): the string.
    """
    return json.dumps(value, ensure_ascii=False)


def event_text(event: ParsedValue) -> str:
    """A --stream event as JSON text: its path, then its leaf, a number
    spelled as its literal (see NumberText).

    Args:
        event (ParsedValue): ``[path]`` or ``[path, leaf]``, as the
            streaming parser hands it out.
    """
    assert isinstance(event, list)
    path = json.dumps(event[0], ensure_ascii=False, separators=(",", ":"))
    if len(event) < 2:
        return f"[{path}]"
    leaf = event[1]
    text = (
        leaf.text
        if isinstance(leaf, NumberText)
        else json.dumps(leaf, ensure_ascii=False)
    )
    return f"[{path},{text}]"


def _unhex4(data: bytes | bytearray, at: int) -> int:
    try:
        text = bytes(data[at : at + 4]).decode("ascii")
    except UnicodeDecodeError:
        return -1
    if len(text) != 4 or not all(c in "0123456789abcdefABCDEF" for c in text):
        return -1
    return int(text, 16)


def _is_number(value: "ParsedValue | NoValue") -> bool:
    return isinstance(value, (int, float, NumberText)) and not isinstance(
        value, bool
    )


class JqParser:
    """jq 1.8.2's JSON parser, byte for byte.

    This follows jq's src/jv_parse.c (MIT; see
    licenses/third_party/jq.txt): the same states, checks and messages,
    and the same line and column counters, which count bytes. It takes
    what jq takes (NaN, Infinity, a leading `+`, `.5`, `01`) and refuses
    where jq refuses: `1true` is one bad numeric literal, `truefalse` one
    bad literal, and a string is checked only at its closing quote. A
    value completes where jq's does, a string or a container at its
    closer and a number or a literal at the byte after it, so `1]` fails
    before printing 1 while `1 ]` prints it first.

    Feed it one buffer at a time (jv_parser_set_buf) and pull what it
    parsed (jv_parser_next); the reader over it decides the buffers.
    What it parsed is also there as text (see text()), which is what
    libjq is handed: jq keeps a number's literal and an object's key order,
    and the text keeps both where the value cannot.

    Args:
        seq (bool): --seq, an RFC 7464 text sequence: nothing counts before
            the first RS, and a bad value is reported and skipped.
        streaming (bool): --stream, hand out `[path, leaf]` events as the
            input goes by instead of whole values.
    """

    def __init__(self, seq: bool = False, streaming: bool = False) -> None:
        self._seq = seq
        self._streaming = streaming
        self._literal_run = LITERAL_RUN_SEQ if seq else LITERAL_RUN
        self._string_run = STRING_RUN_SEQ if seq else STRING_RUN
        self._stack: list[ParsedValue] = []
        self._path: list[ParsedValue] = []
        self._last_seen = LastSeen.NONE
        self._output: "list[ParsedValue] | NoValue" = NO_VALUE
        self._next: "ParsedValue | NoValue" = NO_VALUE
        self._produced: "ParsedValue | NoValue" = NO_VALUE
        self._token = bytearray()
        self._line = 1
        self._column = 0
        self._state = ParseState.WAITING_FOR_RS if seq else ParseState.NORMAL
        self._last_ch_was_ws = False
        self._eof = False
        self._bom = 0
        self._buf: bytes | None = None
        self._pos = 0
        self._partial = False
        # Where the bytes of the next value begin in the buffer, the bytes
        # of it earlier buffers held, whether the value last completed
        # ended before the byte that completed it (a literal does), and
        # the last value's bytes, or under --stream the last event.
        self._mark = 0
        self._carry = bytearray()
        self._before = False
        self._text = b""
        self._last: ParsedValue = None

    def feed(self, data: bytes, partial: bool) -> None:
        """Hand the parser its next buffer (jv_parser_set_buf), once the
        one before it is used up. A UTF-8 BOM is stripped from the start
        of the whole input; a BOM cut short is reported by next().

        Args:
            data (bytes): the buffer.
            partial (bool): whether more input follows it.
        """
        start = 0
        while start < len(data) and self._bom < BOM_DONE:
            if data[start] == UTF8_BOM[self._bom]:
                start += 1
                self._bom += 1
            elif self._bom == 0:
                self._bom = BOM_DONE
            else:
                self._bom = BOM_MALFORMED
        self._buf = data
        self._pos = start
        self._partial = partial
        self._mark = start

    def text(self) -> str:
        """The JSON text of the value next() handed back last, which jq's
        parser reads as that value: the bytes it was read from, or under
        --stream the event with a number leaf spelled as its literal."""
        if self._streaming:
            return event_text(self._last)
        return decode_utf8(self._text)

    def remaining(self) -> int:
        """Bytes of the current buffer not yet parsed."""
        return 0 if self._buf is None else len(self._buf) - self._pos

    def clean(self) -> bool:
        """Whether the parser stands between two whole values with nothing
        pending, which is where a value can be taken from the input in one
        step and handed over as if the parser had read it. A BOM read only
        in part is pending too: the check goes on into the next input."""
        return (
            not self._seq
            and not self._streaming
            and not self._eof
            and self._state is ParseState.NORMAL
            and not self._stack
            and not self._token
            and self._next is NO_VALUE
            and self.remaining() == 0
            and self._bom in (0, BOM_DONE)
        )

    def bom_skip(self, data: bytes) -> int | None:
        """How many leading bytes the BOM check would strip from the
        start of the input, for a caller that parses the start itself;
        None when they begin a BOM they do not finish, which is the
        parser's to report.

        Args:
            data (bytes): the first bytes of the input.
        """
        if self._bom >= BOM_DONE:
            return 0
        if data.startswith(UTF8_BOM):
            return len(UTF8_BOM)
        return 0 if data[:1] != UTF8_BOM[:1] else None

    def skip(self, data: bytes | bytearray, start: int, stop: int) -> None:
        """Count bytes a caller parsed itself (see clean()) as read: the
        BOM check is settled, the line and column move on, and the last
        byte decides whether the parser last saw whitespace.

        Args:
            data (bytes | bytearray): the bytes, a BOM before `start`
                included.
            start (int): the first index taken past the BOM.
            stop (int): just past the last.
        """
        self._bom = BOM_DONE
        if stop > start:
            self._advance(data, start, stop)
            self._last_ch_was_ws = data[stop - 1] in WHITESPACE

    def next(self) -> "ParsedValue | JqParseError | NoValue":
        """The next value, the parse error that stops it, or NO_VALUE when
        the buffer ran out first or the input ended with nothing left
        (jv_parser_next)."""
        if self._eof or self._buf is None:
            return NO_VALUE
        if self._bom == BOM_MALFORMED:
            if not self._seq:
                return JqParseError("Malformed BOM")
            self._state = ParseState.WAITING_FOR_RS
            self._reset()
        if self._streaming:
            done = self._stream_check_done()
            if done is not NO_VALUE:
                self._last = done
                return done
        self._produced = NO_VALUE
        buf = self._buf
        end = len(buf)
        pos = self._pos
        msg: str | Scanned | None = None
        ch = -1
        while msg is None and pos < end:
            state = self._state
            if state is ParseState.WAITING_FOR_RS:
                rs = buf.find(b"\x1e", pos)
                stop = end if rs < 0 else rs + 1
                self._advance(buf, pos, stop)
                pos = stop
                self._mark = pos
                if rs >= 0:
                    self._state = ParseState.NORMAL
                continue
            ch = buf[pos]
            if state is ParseState.NORMAL:
                if (
                    ch not in WHITESPACE
                    and ch not in STRUCTURE
                    and (ch != QUOTE and not (self._seq and ch == RS))
                ):
                    match = self._literal_run.match(buf, pos)
                    stop = match.end() if match else pos + 1
                    self._token += buf[pos:stop]
                    self._column += stop - pos
                    self._last_ch_was_ws = False
                    pos = stop
                    continue
                if ch in WHITESPACE and not self._token:
                    match = WHITESPACE_RUN.match(buf, pos)
                    stop = match.end() if match else pos + 1
                    self._advance(buf, pos, stop)
                    self._last_ch_was_ws = True
                    pos = stop
                    continue
            elif (
                state is ParseState.STRING
                and ch != QUOTE
                and ch != BACKSLASH
                and not (self._seq and ch == RS)
            ):
                match = self._string_run.match(buf, pos)
                stop = match.end() if match else pos + 1
                self._token += buf[pos:stop]
                self._advance(buf, pos, stop)
                self._last_ch_was_ws = False
                pos = stop
                continue
            pos += 1
            msg = self._scan(ch)
        self._pos = pos
        if msg is Scanned.OUTPUT:
            produced = self._produced
            if produced is NO_VALUE:
                # An RS dropped what it cut short.
                self._mark = pos
            else:
                self._take(buf, pos - 1 if self._before else pos)
                self._last = produced
            return produced
        if msg is not None:
            self._mark = pos
            where = f"at line {self._line}, column {self._column}"
            if ch != RS and self._seq:
                self._state = ParseState.WAITING_FOR_RS
                failure = JqParseError(f"{msg} {where} (need RS to resync)")
                self._reset()
                return failure
            failure = JqParseError(f"{msg} {where}")
            self._reset()
            if not self._seq:
                self._buf = None
                self._pos = 0
            return failure
        if self._partial:
            self._hold(buf, end)
            return NO_VALUE
        value = self._at_eof()
        if value is not NO_VALUE and not isinstance(value, JqParseError):
            self._take(buf, end)
            self._last = value
        return value

    def _take(self, buf: bytes, stop: int) -> None:
        # The bytes of the value just completed, which end at `stop`: the
        # next value's begin after them.
        if self._streaming:
            return
        carry = self._carry
        if carry:
            carry += buf[self._mark : stop]
            self._text = bytes(carry).lstrip(SEPARATORS)
            carry.clear()
        else:
            self._text = buf[self._mark : stop].lstrip(SEPARATORS)
        self._mark = stop

    def _hold(self, buf: bytes, stop: int) -> None:
        # Keep the bytes of a value the buffer ended inside of.
        if self._streaming:
            return
        held = buf[self._mark : stop]
        self._carry += held if self._carry else held.lstrip(SEPARATORS)
        self._mark = stop

    def _at_eof(self) -> "ParsedValue | JqParseError | NoValue":
        self._eof = True
        where = f"at EOF at line {self._line}, column {self._column}"
        if self._state is ParseState.WAITING_FOR_RS:
            return JqParseError(f"Unfinished abandoned text {where}")
        if self._state is not ParseState.NORMAL:
            return self._fail_at_eof(f"Unfinished string {where}")
        msg = self._check_literal()
        if msg is not None:
            return self._fail_at_eof(f"{msg} {where}")
        if self._path if self._streaming else self._stack:
            return self._fail_at_eof(f"Unfinished JSON term {where}")
        value: "ParsedValue | NoValue" = self._next
        if self._streaming and value is not NO_VALUE:
            value = [list(self._path), value]
        self._next = NO_VALUE
        if self._seq and not self._last_ch_was_ws and _is_number(value):
            return JqParseError(
                f"Potentially truncated top-level numeric value {where}"
            )
        return value

    def _fail_at_eof(self, message: str) -> JqParseError:
        self._reset()
        self._state = ParseState.WAITING_FOR_RS
        return JqParseError(message)

    def _advance(self, data: bytes | bytearray, start: int, stop: int) -> None:
        newlines = data.count(b"\n", start, stop)
        if newlines:
            self._line += newlines
            self._column = stop - (data.rfind(b"\n", start, stop) + 1)
        else:
            self._column += stop - start

    def _reset(self) -> None:
        if self._streaming:
            self._path = []
        self._last_seen = LastSeen.NONE
        self._output = NO_VALUE
        self._next = NO_VALUE
        self._stack = []
        self._token.clear()
        self._carry.clear()
        self._state = ParseState.NORMAL

    def _value(self, value: ParsedValue) -> str | None:
        if self._streaming:
            if self._next is not NO_VALUE or self._last_seen is LastSeen.VALUE:
                return EXPECTED_SEPARATOR
            self._last_seen = LastSeen.VALUE if self._path else LastSeen.NONE
        elif self._next is not NO_VALUE:
            return EXPECTED_SEPARATOR
        self._next = value
        return None

    def _check_done(self) -> "ParsedValue | NoValue":
        if self._streaming:
            return self._stream_check_done()
        if not self._stack and self._next is not NO_VALUE:
            done = self._next
            self._next = NO_VALUE
            return done
        return NO_VALUE

    def _stream_check_done(self) -> "ParsedValue | NoValue":
        if not self._path and self._next is not NO_VALUE:
            done: ParsedValue = [[], self._next]
            self._next = NO_VALUE
            return done
        output = self._output
        if output is NO_VALUE:
            return NO_VALUE
        if len(output) > 2:
            self._output = output[:1]
            return output[:2]
        self._output = NO_VALUE
        return output

    def _check_truncation(self) -> bool:
        if self._streaming:
            nxt = self._next
            return bool(self._path) or (
                nxt is not NO_VALUE and not isinstance(nxt, (str, list, dict))
            )
        return not self._last_ch_was_ws and (
            bool(self._stack) or bool(self._token) or _is_number(self._next)
        )

    def _is_top_num(self) -> bool:
        above = self._path if self._streaming else self._stack
        return not above and _is_number(self._next)

    def _scan(self, ch: int) -> str | Scanned | None:
        self._column += 1
        if ch == NEWLINE:
            self._line += 1
            self._column = 0
        if self._seq and ch == RS:
            if self._check_truncation():
                if self._check_literal() is None and self._is_top_num():
                    return "Potentially truncated top-level numeric value"
                return "Truncated value"
            msg = self._check_literal()
            if msg is not None:
                return msg
            if self._state is ParseState.NORMAL:
                done = self._check_done()
                if done is not NO_VALUE:
                    self._produced = done
                    self._before = True
                    return Scanned.OUTPUT
            self._reset()
            self._produced = NO_VALUE
            return Scanned.OUTPUT
        answer: Scanned | None = None
        self._last_ch_was_ws = False
        if self._state is ParseState.NORMAL:
            literal = (
                ch not in WHITESPACE and ch not in STRUCTURE and ch != QUOTE
            )
            if ch in WHITESPACE:
                self._last_ch_was_ws = True
            if not literal:
                msg = self._check_literal()
                if msg is not None:
                    return msg
                done = self._check_done()
                if done is not NO_VALUE:
                    self._produced = done
                    self._before = True
                    answer = Scanned.OUTPUT
            if literal:
                self._token.append(ch)
            elif ch == QUOTE:
                self._state = ParseState.STRING
            elif ch in STRUCTURE:
                msg = (
                    self._stream_token(ch)
                    if self._streaming
                    else self._parse_token(ch)
                )
                if msg is not None:
                    return msg
            done = self._check_done()
            if done is not NO_VALUE:
                self._produced = done
                self._before = False
                answer = Scanned.OUTPUT
        elif ch == QUOTE and self._state is ParseState.STRING:
            msg = self._found_string()
            if msg is not None:
                return msg
            self._state = ParseState.NORMAL
            done = self._check_done()
            if done is not NO_VALUE:
                self._produced = done
                self._before = False
                answer = Scanned.OUTPUT
        else:
            self._token.append(ch)
            self._state = (
                ParseState.STRING_ESCAPE
                if ch == BACKSLASH and self._state is ParseState.STRING
                else ParseState.STRING
            )
        return answer

    def _check_literal(self) -> str | None:
        token = self._token
        if not token:
            return None
        first = token[0]
        pattern: bytes | None = None
        value: ParsedValue = None
        if first == ord("t"):
            pattern, value = b"true", True
        elif first == ord("f"):
            pattern, value = b"false", False
        elif first == APOSTROPHE:
            return "Invalid string literal; expected \", but got '"
        elif first == LOWER_N and len(token) > 1 and token[1] == LOWER_U:
            pattern, value = b"null", None
        if pattern is not None:
            if token != pattern:
                return "Invalid literal"
        else:
            literal = bytes(token).split(b"\0", 1)[0]
            number = number_value(literal)
            if number is NO_VALUE:
                return "Invalid numeric literal"
            value = (
                NumberText(literal.decode("ascii"))
                if self._streaming
                else number
            )
        msg = self._value(value)
        if msg is not None:
            return msg
        token.clear()
        return None

    def _found_string(self) -> str | None:
        token = bytes(self._token)
        out = bytearray()
        at = 0
        end = len(token)
        while True:
            slash = token.find(b"\\", at)
            run = token[at:] if slash < 0 else token[at:slash]
            if CONTROL.search(run):
                return CONTROL_CHARACTER
            out += run
            if slash < 0:
                break
            at = slash + 1
            if at >= end:
                return "Expected escape character at end of string"
            code = token[at]
            at += 1
            plain = ESCAPES.get(code)
            if plain is not None:
                out += plain
                continue
            if code != LOWER_U:
                return "Invalid escape"
            if at + 4 > end:
                return "Invalid \\uXXXX escape"
            point = _unhex4(token, at)
            if point < 0:
                return "Invalid characters in \\uXXXX escape"
            at += 4
            if 0xD800 <= point <= 0xDBFF:
                if (
                    at + 6 > end
                    or token[at] != BACKSLASH
                    or token[at + 1] != LOWER_U
                ):
                    return SURROGATE_PAIR
                low = _unhex4(token, at + 2)
                if not 0xDC00 <= low <= 0xDFFF:
                    return SURROGATE_PAIR
                at += 6
                point = 0x10000 + (((point - 0xD800) << 10) | (low - 0xDC00))
            out += chr(point).encode("utf-8", "surrogatepass")
        msg = self._value(decode_utf8(bytes(out)))
        if msg is not None:
            return msg
        self._token.clear()
        return None

    def _parse_token(self, ch: int) -> str | None:
        stack = self._stack
        if ch in (OPEN_BRACKET, OPEN_BRACE):
            if len(stack) >= MAX_PARSING_DEPTH:
                return DEPTH_EXCEEDED
            if self._next is not NO_VALUE:
                return EXPECTED_SEPARATOR
            stack.append([] if ch == OPEN_BRACKET else {})
        elif ch == COLON:
            if self._next is NO_VALUE:
                return "Expected string key before ':'"
            if not stack or not isinstance(stack[-1], dict):
                return "':' not as part of an object"
            if not isinstance(self._next, str):
                return "Object keys must be strings"
            stack.append(self._next)
            self._next = NO_VALUE
        elif ch == COMMA:
            if self._next is NO_VALUE:
                return "Expected value before ','"
            if not stack:
                return "',' not as part of an object or array"
            top = stack[-1]
            if isinstance(top, list):
                top.append(self._next)
            elif isinstance(top, str):
                owner = stack[-2]
                assert isinstance(owner, dict)
                owner[top] = self._next
                stack.pop()
            else:
                return "Objects must consist of key:value pairs"
            self._next = NO_VALUE
        elif ch == CLOSE_BRACKET:
            if not stack or not isinstance(stack[-1], list):
                return "Unmatched ']'"
            if self._next is not NO_VALUE:
                stack[-1].append(self._next)
            elif stack[-1]:
                return "Expected another array element"
            self._next = stack.pop()
        elif ch == CLOSE_BRACE:
            if not stack:
                return "Unmatched '}'"
            if self._next is not NO_VALUE:
                top = stack[-1]
                if not isinstance(top, str):
                    return "Objects must consist of key:value pairs"
                owner = stack[-2]
                assert isinstance(owner, dict)
                owner[top] = self._next
                stack.pop()
            else:
                if not isinstance(stack[-1], dict):
                    return "Unmatched '}'"
                if stack[-1]:
                    return "Expected another key-value pair"
            self._next = stack.pop()
        return None

    def _stream_token(self, ch: int) -> str | None:
        path = self._path
        last_seen = self._last_seen
        if ch in (OPEN_BRACKET, OPEN_BRACE) and len(path) >= MAX_PARSING_DEPTH:
            return DEPTH_EXCEEDED
        if ch == OPEN_BRACKET:
            if self._next is not NO_VALUE:
                return "Expected a separator between values"
            if last_seen is LastSeen.OPEN_OBJECT:
                return "Expected string key after '{', not '['"
            if last_seen is LastSeen.COMMA and not _is_number(path[-1]):
                return "Expected string key after ',' in object, not '['"
            path.append(0)
            self._last_seen = LastSeen.OPEN_ARRAY
        elif ch == OPEN_BRACE:
            if last_seen is LastSeen.VALUE:
                return "Expected a separator between values"
            if last_seen is LastSeen.OPEN_OBJECT:
                return "Expected string key after '{', not '{'"
            if last_seen is LastSeen.COMMA and not _is_number(path[-1]):
                return "Expected string key after ',' in object, not '{'"
            path.append(None)
            self._last_seen = LastSeen.OPEN_OBJECT
        elif ch == COLON:
            if not path or _is_number(path[-1]):
                return "':' not as part of an object"
            if self._next is NO_VALUE or last_seen is LastSeen.NONE:
                return "Expected string key before ':'"
            if not isinstance(self._next, str):
                return "Object keys must be strings"
            if last_seen is not LastSeen.VALUE:
                return "':' should follow a key"
            self._last_seen = LastSeen.COLON
            path[-1] = self._next
            self._next = NO_VALUE
        elif ch == COMMA:
            if last_seen is not LastSeen.VALUE:
                return "Expected value before ','"
            if not path:
                return "',' not as part of an object or array"
            last = path[-1]
            if _is_number(last):
                assert isinstance(last, int)
                if self._next is not NO_VALUE:
                    self._output = [list(path), self._next]
                    self._next = NO_VALUE
                path[-1] = last + 1
            elif isinstance(last, str):
                if self._next is not NO_VALUE:
                    self._output = [list(path), self._next]
                    self._next = NO_VALUE
                path[-1] = None
            else:
                return "Objects must consist of key:value pairs"
            self._last_seen = LastSeen.COMMA
        elif ch == CLOSE_BRACKET:
            if not path:
                return "Unmatched ']' at the top-level"
            if last_seen is LastSeen.COMMA:
                return "Expected another array element"
            if not _is_number(path[-1]):
                return "Unmatched ']' in the middle of an object"
            if self._next is not NO_VALUE:
                self._output = [list(path), self._next, True]
            elif last_seen is not LastSeen.OPEN_ARRAY:
                self._output = [list(path)]
            path.pop()
            self._next = NO_VALUE
            if last_seen is LastSeen.OPEN_ARRAY:
                self._output = [list(path), []]
            self._last_seen = LastSeen.VALUE if path else LastSeen.NONE
        elif ch == CLOSE_BRACE:
            if not path:
                return "Unmatched '}' at the top-level"
            if last_seen is LastSeen.COMMA:
                return "Expected another key:value pair"
            last = path[-1]
            if _is_number(last):
                return "Unmatched '}' in the middle of an array"
            if self._next is not NO_VALUE:
                if not isinstance(last, str):
                    return "Objects must consist of key:value pairs"
                self._output = [list(path), self._next, True]
            else:
                if last_seen is LastSeen.COLON:
                    return "Missing value in key:value pair"
                if last_seen is LastSeen.OPEN_ARRAY:
                    return "Unmatched '}' in the middle of an array"
                if last_seen not in (LastSeen.VALUE, LastSeen.OPEN_OBJECT):
                    return "Unmatched '}'"
                if last_seen is not LastSeen.OPEN_OBJECT:
                    self._output = [list(path)]
            path.pop()
            self._next = NO_VALUE
            if last_seen is LastSeen.OPEN_OBJECT:
                self._output = [list(path), {}]
            self._last_seen = LastSeen.VALUE if path else LastSeen.NONE
        return None
