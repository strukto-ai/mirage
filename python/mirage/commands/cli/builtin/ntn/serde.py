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

import math

EOF_LIST = "EOF while parsing a list"
EOF_OBJECT = "EOF while parsing an object"
EOF_STRING = "EOF while parsing a string"
EOF_VALUE = "EOF while parsing a value"
EXPECTED_COLON = "expected `:`"
EXPECTED_IDENT = "expected ident"
EXPECTED_LIST_END = "expected `,` or `]`"
EXPECTED_OBJECT_END = "expected `,` or `}`"
EXPECTED_VALUE = "expected value"
INVALID_ESCAPE = "invalid escape"
INVALID_NUMBER = "invalid number"
KEY_MUST_BE_STRING = "key must be a string"
NUMBER_OUT_OF_RANGE = "number out of range"
RECURSION_LIMIT = "recursion limit exceeded"
STRING_CONTROL = ("control character (\\u0000-\\u001F) found while parsing "
                  "a string")
TRAILING_CHARACTERS = "trailing characters"
TRAILING_COMMA = "trailing comma"
UNEXPECTED_HEX_END = "unexpected end of hex escape"

# serde_json's own default depth, probed: 127 nested lists parse and the
# 128th is refused, at the column of its opening bracket.
MAX_DEPTH = 127

BRACE_OPEN = 0x7B
BRACE_CLOSE = 0x7D
BRACKET_OPEN = 0x5B
BRACKET_CLOSE = 0x5D
BACKSLASH = 0x5C
COLON = 0x3A
COMMA = 0x2C
DOT = 0x2E
MINUS = 0x2D
NEWLINE = 0x0A
PLUS = 0x2B
QUOTE = 0x22
SPACE = 0x20
ZERO = 0x30

HEX_DIGITS = b"0123456789ABCDEFabcdef"
SHORT_ESCAPES = b"\"\\/bfnrt"
WHITESPACE = b" \n\r\t"
EXPONENTS = (0x65, 0x45)
SIGNS = (PLUS, MINUS)
IDENTS = {0x74: b"true", 0x66: b"false", 0x6E: b"null"}
LEAD_SURROGATE_LOW = 0xD800
LEAD_SURROGATE_HIGH = 0xDBFF
HEX_WIDTH = 4


class SerdeRefusal(Exception):
    pass


def is_digit(byte: int | None) -> bool:
    """Whether a byte is an ASCII digit, tolerating end of input.

    Args:
        byte (int | None): the byte, None at end of input.
    """
    return byte is not None and ZERO <= byte <= ZERO + 9


class SerdeScan:
    """A JSON scanner that refuses in serde_json's exact words.

    mirage's ``ntn`` has to reject a malformed inline input the way the
    Rust binary does, and that wording is serde_json's own, down to a
    byte column. Neither engine parser can supply it: python's ``json``
    and JavaScript's ``JSON.parse`` each have their own vocabulary and
    their own idea of a position, and the two do not even agree with
    each other. So this scanner decides validity, and the engine parser
    only ever runs on input it has already accepted.

    Two position rules, both probed against ntn 0.21.9: columns count
    **bytes**, not characters (``["é"x`` fails at column 6), and a
    newline advances the line and resets the column to 0 (``{`` then a
    newline fails at line 2 column 0). The reported column is the
    1-based offset of the last byte read, which at end of input is the
    length of the line.
    """

    def __init__(self, raw: bytes) -> None:
        self.raw = raw
        self.at = 0
        self.line = 1
        self.line_start = 0
        self.depth = 0

    @property
    def column(self) -> int:
        return self.at - self.line_start

    def fail(self, code: str) -> SerdeRefusal:
        """The refusal for a code at the position already reached.

        Args:
            code (str): serde_json's ErrorCode text.
        """
        return SerdeRefusal(f"{code} at line {self.line} "
                            f"column {self.column}")

    def peek(self) -> int | None:
        return self.raw[self.at] if self.at < len(self.raw) else None

    def take(self) -> int | None:
        if self.at >= len(self.raw):
            return None
        byte = self.raw[self.at]
        self.at += 1
        if byte == NEWLINE:
            self.line += 1
            self.line_start = self.at
        return byte

    def drain(self) -> None:
        """Consume the rest of the input, keeping the position honest.

        serde reports a short ``\\u`` escape at the end of the buffer,
        and it derives line and column by scanning what it skipped, so
        this cannot shortcut to the length.
        """
        while self.take() is not None:
            continue

    def skip_ws(self) -> None:
        while True:
            byte = self.peek()
            if byte is None or byte not in WHITESPACE:
                return
            self.take()

    def enter(self) -> None:
        self.depth += 1
        if self.depth > MAX_DEPTH:
            raise self.fail(RECURSION_LIMIT)

    def document(self) -> None:
        self.value()
        self.skip_ws()
        if self.peek() is not None:
            self.take()
            raise self.fail(TRAILING_CHARACTERS)

    def value(self) -> None:
        self.skip_ws()
        head = self.peek()
        if head is None:
            raise self.fail(EOF_VALUE)
        if head == BRACE_OPEN:
            self.take()
            self.obj()
            return
        if head == BRACKET_OPEN:
            self.take()
            self.arr()
            return
        if head == QUOTE:
            self.take()
            self.string()
            return
        if head in IDENTS:
            self.ident(IDENTS[head])
            return
        if head == MINUS or is_digit(head):
            self.number()
            return
        self.take()
        raise self.fail(EXPECTED_VALUE)

    def obj(self) -> None:
        self.enter()
        self.skip_ws()
        if self.peek() is None:
            raise self.fail(EOF_OBJECT)
        if self.peek() == BRACE_CLOSE:
            self.take()
            self.depth -= 1
            return
        while True:
            self.skip_ws()
            key = self.peek()
            if key is None:
                raise self.fail(EOF_OBJECT)
            if key != QUOTE:
                self.take()
                raise self.fail(KEY_MUST_BE_STRING)
            self.take()
            self.string()
            self.skip_ws()
            colon = self.take()
            if colon is None:
                raise self.fail(EOF_OBJECT)
            if colon != COLON:
                raise self.fail(EXPECTED_COLON)
            self.value()
            self.skip_ws()
            sep = self.take()
            if sep is None:
                raise self.fail(EOF_OBJECT)
            if sep == BRACE_CLOSE:
                self.depth -= 1
                return
            if sep != COMMA:
                raise self.fail(EXPECTED_OBJECT_END)
            # Past a comma the next key is read as a value would be, so
            # a closing brace is the trailing comma and end of input is
            # the value error, not the object one that an unterminated
            # `{` reports.
            self.skip_ws()
            if self.peek() == BRACE_CLOSE:
                self.take()
                raise self.fail(TRAILING_COMMA)
            if self.peek() is None:
                raise self.fail(EOF_VALUE)

    def arr(self) -> None:
        self.enter()
        self.skip_ws()
        if self.peek() is None:
            raise self.fail(EOF_LIST)
        if self.peek() == BRACKET_CLOSE:
            self.take()
            self.depth -= 1
            return
        while True:
            self.value()
            self.skip_ws()
            sep = self.take()
            if sep is None:
                raise self.fail(EOF_LIST)
            if sep == BRACKET_CLOSE:
                self.depth -= 1
                return
            if sep != COMMA:
                raise self.fail(EXPECTED_LIST_END)
            # Only a closing bracket is the trailing-comma case. End of
            # input falls through to the next value, which is why `[1,`
            # is a value error and `[1,]` is a comma one.
            self.skip_ws()
            if self.peek() == BRACKET_CLOSE:
                self.take()
                raise self.fail(TRAILING_COMMA)

    def string(self) -> None:
        while True:
            byte = self.take()
            if byte is None:
                raise self.fail(EOF_STRING)
            if byte == QUOTE:
                return
            if byte == BACKSLASH:
                self.escape()
                continue
            if byte < SPACE:
                raise self.fail(STRING_CONTROL)

    def escape(self) -> None:
        marker = self.take()
        if marker is None:
            raise self.fail(EOF_STRING)
        if marker in SHORT_ESCAPES:
            return
        if marker != 0x75:
            raise self.fail(INVALID_ESCAPE)
        code = self.hex_escape()
        if not LEAD_SURROGATE_LOW <= code <= LEAD_SURROGATE_HIGH:
            return
        opener = self.take()
        if opener is None:
            raise self.fail(EOF_STRING)
        if opener != BACKSLASH:
            raise self.fail(UNEXPECTED_HEX_END)
        marker = self.take()
        if marker is None:
            raise self.fail(EOF_STRING)
        if marker != 0x75:
            raise self.fail(UNEXPECTED_HEX_END)
        self.hex_escape()

    def hex_escape(self) -> int:
        # serde checks that four bytes remain before reading any of
        # them, so a short escape is end-of-string at the buffer's end
        # rather than a bad digit where it ran out.
        if self.at + HEX_WIDTH > len(self.raw):
            self.drain()
            raise self.fail(EOF_STRING)
        chunk = self.raw[self.at:self.at + HEX_WIDTH]
        for _ in range(HEX_WIDTH):
            self.take()
        if any(byte not in HEX_DIGITS for byte in chunk):
            raise self.fail(INVALID_ESCAPE)
        return int(chunk.decode("ascii"), 16)

    def ident(self, word: bytes) -> None:
        for expected in word:
            byte = self.take()
            if byte is None:
                raise self.fail(EOF_VALUE)
            if byte != expected:
                raise self.fail(EXPECTED_IDENT)

    def digits(self) -> None:
        while is_digit(self.peek()):
            self.take()

    def run_digits(self) -> None:
        """Consume a digit run that the grammar requires to be non-empty."""
        first = self.take()
        if first is None:
            raise self.fail(EOF_VALUE)
        if not is_digit(first):
            raise self.fail(INVALID_NUMBER)
        self.digits()

    def number(self) -> None:
        start = self.at
        if self.peek() == MINUS:
            self.take()
        lead = self.take()
        if lead is None:
            raise self.fail(EOF_VALUE)
        if not is_digit(lead):
            raise self.fail(INVALID_NUMBER)
        if lead == ZERO:
            if is_digit(self.peek()):
                self.take()
                raise self.fail(INVALID_NUMBER)
        else:
            self.digits()
        if self.peek() == DOT:
            self.take()
            self.run_digits()
        if self.peek() in EXPONENTS:
            self.take()
            if self.peek() in SIGNS:
                self.take()
            self.run_digits()
        # An integer too wide for u64/i64 becomes an f64 in serde too,
        # so overflow is the one range error either shape can hit.
        if math.isinf(float(self.raw[start:self.at].decode("ascii"))):
            raise self.fail(NUMBER_OUT_OF_RANGE)


def serde_message(text: str) -> str | None:
    """serde_json's parse error for `text`, or None if it would parse.

    Args:
        text (str): the candidate JSON document.

    Returns:
        str | None: the ``<code> at line L column C`` text serde_json
            renders for the first error, None when the document parses.
    """
    scan = SerdeScan(text.encode())
    try:
        scan.document()
    except SerdeRefusal as refusal:
        return str(refusal)
    return None
