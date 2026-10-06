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
from dataclasses import dataclass, replace
from functools import cache

from mirage.commands.builtin.utils.charset import (
    ALL,
    CharSet,
    host_char,
    host_class,
)
from mirage.commands.builtin.utils.types import HostRegex
from mirage.commands.builtin.utils.unicode_tables import (
    ASCII_CLASSES,
    ASCII_DIGIT,
    ASCII_SPACE,
    ASCII_WORD,
    WHITE_SPACE,
    category,
    fold,
    rust_word,
    unicode_property,
)

# regex-syntax's error kinds, worded as ripgrep 14.1.1 prints them.
LOOK_AROUND = (
    "look-around, including look-ahead and look-behind, is not supported"
)
BACKREFERENCE = "backreferences are not supported"
GROUP_UNCLOSED = "unclosed group"
GROUP_UNOPENED = "unopened group"
CLASS_UNCLOSED = "unclosed character class"
REPETITION_MISSING = "repetition operator missing expression"
REPETITION_DECIMAL = "repetition quantifier expects a valid decimal"
REPETITION_UNCLOSED = "unclosed counted repetition"
REPETITION_INVALID = (
    "invalid repetition count range, the start must be <= the end"
)
DECIMAL_INVALID = "decimal literal invalid"
ESCAPE_UNRECOGNIZED = "unrecognized escape sequence"
ESCAPE_EOF = "incomplete escape sequence, reached end of pattern prematurely"
ESCAPE_IN_CLASS = "invalid escape sequence found in character class"
RANGE_LITERAL = "invalid range boundary, must be a literal"
RANGE_INVALID = "invalid character class range, the start must be <= the end"
HEX_DIGIT = "invalid hexadecimal digit"
HEX_EMPTY = "hexadecimal literal empty"
HEX_SCALAR = "hexadecimal literal is not a Unicode scalar value"
FLAG_UNRECOGNIZED = "unrecognized flag"
FLAG_DANGLING = "dangling flag negation operator"
FLAG_DUPLICATE = "duplicate flag"
FLAG_REPEATED_NEGATION = "flag negation operator repeated"
FLAG_EOF = "expected flag but got end of regex"
GROUP_NAME_EMPTY = "empty capture group name"
GROUP_NAME_INVALID = "invalid capture group character"
GROUP_NAME_EOF = "unclosed capture group name"
GROUP_NAME_DUPLICATE = "duplicate capture group name"
PROPERTY_UNSUPPORTED = "Unicode property not supported in mirage"
PCRE2_HINT = (
    "Consider enabling PCRE2 with the --pcre2 flag, which can "
    "handle backreferences\nand look-around."
)

FLAG_LETTERS = "imsUuxR"
# An inline flag group that could change case folding: `i` itself, or
# `u`, which turns Unicode folding off. A caseless pattern without one is
# caseless throughout, and the host engine folds it.
INLINE_CASE = re.compile(r"\(\?[a-zA-Z-]*[iu]")
META_ESCAPES = frozenset("\\.+*?()|[]{}^$#&-~")
NAME_START = frozenset("_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
NAME_CHARS = NAME_START | frozenset("0123456789.[]")
HOST_NAME = frozenset(
    "_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
)
SIMPLE_ESCAPES = {
    "a": 0x07,
    "f": 0x0C,
    "t": 0x09,
    "n": 0x0A,
    "r": 0x0D,
    "v": 0x0B,
}
HEX_WIDTH = {"x": 2, "u": 4, "U": 8}


class RustRegexError(Exception):
    """A pattern ripgrep's default engine refuses, framed as rg prints it.

    Args:
        display (str): the pattern regex-syntax parsed, each ``-e``
            wrapped in ``(?:...)`` and joined with ``|``.
        spans (tuple[tuple[int, int], ...]): what the carets mark, as
            half-open character spans; an empty span marks one column.
        message (str): the error kind's text.
        hint (bool): the error is one PCRE2 would not raise, which
            ripgrep follows with its ``--pcre2`` hint.
    """

    def __init__(
        self,
        display: str,
        spans: tuple[tuple[int, int], ...],
        message: str,
        hint: bool = False,
    ) -> None:
        self.display = display
        self.spans = spans
        self.message = message
        self.hint = hint
        super().__init__(self.render())

    def render(self) -> str:
        """The error as rg prints it after its ``rg: `` prefix."""
        marks = [" "] * (len(self.display) + 1)
        for start, end in self.spans:
            for i in range(start, max(end, start + 1)):
                marks[i] = "^"
        carets = "".join(marks).rstrip()
        text = (
            f"regex parse error:\n    {self.display}\n    {carets}\n"
            f"error: {self.message}"
        )
        return text + "\n\n" + PCRE2_HINT if self.hint else text


@dataclass(frozen=True, slots=True)
class Flags:
    """The inline flags in force at one point of a pattern.

    Args:
        i (bool): case-insensitive.
        m (bool): ``^`` and ``$`` match at line boundaries.
        s (bool): ``.`` matches ``\\n``.
        U (bool): greedy and lazy repetition swap.
        u (bool): Unicode classes and case folding.
        x (bool): whitespace and ``#`` comments are ignored.
        R (bool): CRLF mode, where ``.`` also excludes ``\\r``.
    """

    i: bool = False
    m: bool = False
    s: bool = False
    U: bool = False
    u: bool = True
    x: bool = False
    R: bool = False


def word_class(unicode: bool) -> CharSet:
    """``\\w`` in one mode.

    Args:
        unicode (bool): Unicode (the default) rather than ASCII.
    """
    return rust_word() if unicode else ASCII_WORD


@cache
def word_source(unicode: bool) -> str:
    """The host class for ``\\w`` in one mode, built once.

    Args:
        unicode (bool): Unicode rather than ASCII.
    """
    return host_class(word_class(unicode))


def boundary(kind: str, unicode: bool) -> str:
    """One word-boundary assertion as host lookarounds.

    Both hosts' own ``\\b`` is ASCII (python's is its own idea of a word
    character), so every boundary is spelled out over the dialect's word
    class.

    Args:
        kind (str): ``b``, ``B``, ``start``, ``end``, ``start-half`` or
            ``end-half``.
        unicode (bool): Unicode word characters rather than ASCII.
    """
    w = word_source(unicode)
    table = {
        "b": f"(?:(?<={w})(?!{w})|(?<!{w})(?={w}))",
        "B": f"(?:(?<={w})(?={w})|(?<!{w})(?!{w}))",
        "start": f"(?<!{w})(?={w})",
        "end": f"(?<={w})(?!{w})",
        "start-half": f"(?<!{w})",
        "end-half": f"(?!{w})",
    }
    return table[kind]


def line_start(multi_line: bool) -> str:
    """``^`` as the host reads it.

    Args:
        multi_line (bool): also just after a ``\\n``.
    """
    return "(?:^|(?<=\\n))" if multi_line else "^"


def line_end(multi_line: bool) -> str:
    """``$`` as the host reads it; python's own ``$`` also matches
    before a final newline, so the end of input is ``\\Z``.

    Args:
        multi_line (bool): also just before a ``\\n``.
    """
    return "(?=\\n|\\Z)" if multi_line else "\\Z"


def whole_line(source: str, multi_line: bool) -> str:
    """ripgrep's -x: the pattern spans a whole line.

    Args:
        source (str): the host source.
        multi_line (bool): lines end at ``\\n`` inside the subject.
    """
    return f"{line_start(multi_line)}(?:{source}){line_end(multi_line)}"


def whole_word(source: str, unicode: bool = True) -> str:
    """ripgrep's -w: ``\\b{start-half}(?:...)\\b{end-half}``.

    Args:
        source (str): the host source.
        unicode (bool): Unicode word characters, off under --no-unicode.
    """
    return (
        f"{boundary('start-half', unicode)}(?:{source})"
        f"{boundary('end-half', unicode)}"
    )


def display_of(patterns: list[str]) -> str:
    """The one pattern ripgrep parses for a pattern list.

    Args:
        patterns (list[str]): the patterns, one per ``-e`` or line.
    """
    return "|".join(f"(?:{p})" for p in patterns)


@dataclass(slots=True)
class Frame:
    """One open group.

    Args:
        open_at (int): where its ``(`` sits in the pattern.
        out_start (int): where its source begins in ``out``.
        flags (Flags): the flags in force before it opened.
    """

    open_at: int
    out_start: int
    flags: Flags


class RustTranslator:
    """A ripgrep default-engine pattern re-emitted in this host's dialect.

    A single left-to-right scan of the regex-syntax 0.8 grammar ripgrep
    14.1.1 bundles. It refuses what that parser refuses, with its
    wording and spans, and emits everything it accepts as host source
    whose meaning does not depend on the host's own class shorthands:
    ``\\w``, ``\\d``, ``\\s`` and ``\\b`` are Unicode sets spelled out,
    case folding is Unicode simple folding applied to each literal and
    class, and ``(?i)`` scoping is therefore free. Mirrored in
    ``rust_regex.ts``.

    Args:
        display (str): the pattern as regex-syntax sees it.
        flags (Flags): the flags in force at its start.
    """

    def __init__(self, display: str, flags: Flags) -> None:
        self.src = display
        self.pos = 0
        self.flags = flags
        self.out: list[str] = []
        self.atom_start: int | None = None
        self.atom_quantified = False
        self.atom_assertion = False
        self.stack: list[Frame] = []
        self.names: dict[str, tuple[int, int]] = {}

    def fail(
        self, start: int, end: int, message: str, *more: tuple[int, int]
    ) -> RustRegexError:
        """An error over one span (and any auxiliary ones).

        Args:
            start (int): span start.
            end (int): span end, exclusive.
            message (str): the error kind's text.
            *more (tuple[int, int]): auxiliary spans.
        """
        hint = message in (LOOK_AROUND, BACKREFERENCE)
        return RustRegexError(self.src, ((start, end), *more), message, hint)

    def peek(self, offset: int = 0) -> str:
        """The character ``offset`` past the position, or empty.

        Args:
            offset (int): how far ahead.
        """
        return self.src[self.pos + offset : self.pos + offset + 1]

    def skip_space(self) -> None:
        """Skip whitespace and ``#`` comments under ``x``."""
        while self.flags.x and self.pos < len(self.src):
            ch = self.src[self.pos]
            if ch.isspace():
                self.pos += 1
            elif ch == "#":
                end = self.src.find("\n", self.pos)
                self.pos = len(self.src) if end < 0 else end + 1
            else:
                return

    def translate(self) -> str:
        """Scan the whole pattern.

        Returns:
            str: the host source.

        Raises:
            RustRegexError: regex-syntax refuses the pattern.
        """
        while True:
            self.skip_space()
            if self.pos >= len(self.src):
                break
            self.step()
        if self.stack:
            frame = self.stack[-1]
            raise self.fail(frame.open_at, frame.open_at + 1, GROUP_UNCLOSED)
        return "".join(self.out)

    def step(self) -> None:
        """Scan one token."""
        ch = self.src[self.pos]
        if ch == "(":
            self.open_group()
        elif ch == ")":
            self.close_group()
        elif ch == "|":
            self.pos += 1
            self.out.append("|")
            self.atom_start = None
        elif ch == "[":
            cs = self.parse_class()
            self.atom(host_class(cs))
        elif ch in "*+?":
            self.repetition(ch)
        elif ch == "{":
            self.counted_repetition()
        elif ch == "\\":
            self.escape()
        elif ch == ".":
            self.pos += 1
            excluded = (
                CharSet.chars(0x0A, 0x0D)
                if self.flags.R
                else (CharSet.chars(0x0A))
            )
            self.atom(host_class(ALL if self.flags.s else ALL.minus(excluded)))
        elif ch == "^":
            self.pos += 1
            self.assertion(line_start(self.flags.m))
        elif ch == "$":
            self.pos += 1
            self.assertion(line_end(self.flags.m))
        else:
            self.pos += 1
            self.literal(ord(ch))

    def atom(self, text: str) -> None:
        """Emit one repeatable atom.

        Args:
            text (str): its host source.
        """
        self.atom_start = len(self.out)
        self.out.append(text)
        self.atom_quantified = False
        self.atom_assertion = False

    def assertion(self, text: str) -> None:
        """Emit one zero-width assertion, which Rust lets a repetition
        apply to.

        Args:
            text (str): its host source.
        """
        self.atom(text)
        self.atom_assertion = True

    def literal(self, cp: int) -> None:
        """Emit one literal code point, folded under ``i``.

        Args:
            cp (int): the code point.
        """
        if self.flags.i:
            self.atom(host_class(fold(CharSet.chars(cp), not self.flags.u)))
        else:
            self.atom(host_char(cp))

    def set_atom(self, cs: CharSet) -> None:
        """Emit a class-valued escape, folded under ``i``.

        Args:
            cs (CharSet): its members.
        """
        if self.flags.i:
            cs = fold(cs, not self.flags.u)
        self.atom(host_class(cs))

    def open_group(self) -> None:
        """Scan a ``(`` and whatever group syntax follows it."""
        start = self.pos
        src = self.src
        if src.startswith(("(?=", "(?!"), start):
            raise self.fail(start, start + 3, LOOK_AROUND)
        if src.startswith(("(?<=", "(?<!"), start):
            raise self.fail(start, start + 4, LOOK_AROUND)
        self.pos += 1
        if self.peek() != "?":
            self.push(start, "(")
            return
        self.pos += 1
        if src.startswith("P<", self.pos) or self.peek() == "<":
            self.pos += 2 if self.peek() == "P" else 1
            name = self.group_name()
            self.push(start, "(?P<%s>" % name if name else "(")
            return
        if self.peek() == ")":
            raise self.fail(self.pos - 1, self.pos, REPETITION_MISSING)
        flags, scoped = self.parse_flags()
        if scoped:
            self.push(start, "(?:")
            self.flags = flags
        else:
            self.flags = flags
            self.atom_start = None

    def push(self, start: int, opener: str) -> None:
        """Open a group whose host opener is ``opener``.

        Args:
            start (int): where the ``(`` sits.
            opener (str): the host text.
        """
        self.stack.append(Frame(start, len(self.out), self.flags))
        self.out.append(opener)
        self.atom_start = None

    def group_name(self) -> str:
        """Read a capture group name through its ``>``.

        Returns:
            str: the name for the host, empty when the host cannot spell
                it (Rust allows ``.``, ``[`` and ``]``), in which case the
                group stays capturing and unnamed.
        """
        begin = self.pos
        while True:
            if self.pos >= len(self.src):
                raise self.fail(begin, self.pos, GROUP_NAME_EOF)
            ch = self.src[self.pos]
            if ch == ">":
                break
            allowed = NAME_START if self.pos == begin else NAME_CHARS
            if ch not in allowed:
                raise self.fail(self.pos, self.pos + 1, GROUP_NAME_INVALID)
            self.pos += 1
        name = self.src[begin : self.pos]
        if not name:
            raise self.fail(self.pos, self.pos + 1, GROUP_NAME_EMPTY)
        span = (begin, self.pos)
        if name in self.names:
            raise self.fail(*span, GROUP_NAME_DUPLICATE, self.names[name])
        self.names[name] = span
        self.pos += 1
        return name if set(name) <= HOST_NAME else ""

    def parse_flags(self) -> tuple[Flags, bool]:
        """Read ``flags)`` or ``flags:`` after a ``(?``.

        Returns:
            tuple[Flags, bool]: the new flags, and whether they open a
                scoped group (``:``) rather than set the enclosing one's.
        """
        flags = self.flags
        negate: int | None = None
        seen: dict[str, int] = {}
        while True:
            if self.pos >= len(self.src):
                raise self.fail(self.pos, self.pos, FLAG_EOF)
            ch = self.src[self.pos]
            if ch in ":)":
                if negate is not None and negate == self.pos - 1:
                    raise self.fail(negate, negate + 1, FLAG_DANGLING)
                self.pos += 1
                return flags, ch == ":"
            if ch == "-":
                if negate is not None:
                    raise self.fail(
                        self.pos, self.pos + 1, FLAG_REPEATED_NEGATION
                    )
                negate = self.pos
                self.pos += 1
                continue
            if ch not in FLAG_LETTERS:
                raise self.fail(self.pos, self.pos + 1, FLAG_UNRECOGNIZED)
            if ch in seen:
                raise self.fail(
                    self.pos,
                    self.pos + 1,
                    FLAG_DUPLICATE,
                    (seen[ch], seen[ch] + 1),
                )
            seen[ch] = self.pos
            flags = replace(flags, **{ch: negate is None})
            self.pos += 1

    def close_group(self) -> None:
        """Scan a ``)``."""
        if not self.stack:
            raise self.fail(self.pos, self.pos + 1, GROUP_UNOPENED)
        frame = self.stack.pop()
        self.pos += 1
        self.out.append(")")
        self.flags = frame.flags
        self.atom_start = frame.out_start
        self.atom_quantified = False
        self.atom_assertion = False

    def repetition(self, op: str) -> None:
        """Scan ``*``, ``+`` or ``?`` and an optional lazy ``?``.

        Args:
            op (str): the operator.
        """
        at = self.pos
        self.pos += 1
        lazy = False
        if self.peek() == "?":
            self.pos += 1
            lazy = True
        self.apply(op, at, 0 if op != "+" else 1, lazy)

    def counted_repetition(self) -> None:
        """Scan ``{n}``, ``{n,}`` or ``{n,m}`` and an optional lazy ``?``."""
        start = self.pos
        if self.atom_start is None:
            raise self.fail(start, start + 1, REPETITION_MISSING)
        self.pos += 1
        self.skip_space()
        if self.pos >= len(self.src):
            raise self.fail(start, self.pos, REPETITION_UNCLOSED)
        low = self.decimal()
        high: int | None = low
        if self.pos >= len(self.src):
            raise self.fail(start, self.pos, REPETITION_UNCLOSED)
        if self.peek() == ",":
            self.pos += 1
            self.skip_space()
            if self.pos >= len(self.src):
                raise self.fail(start, self.pos, REPETITION_UNCLOSED)
            high = None if self.peek() == "}" else self.decimal()
        self.skip_space()
        if self.pos >= len(self.src) or self.peek() != "}":
            raise self.fail(start, self.pos, REPETITION_UNCLOSED)
        self.pos += 1
        if high is not None and low > high:
            raise self.fail(start, self.pos, REPETITION_INVALID)
        lazy = False
        if self.peek() == "?":
            self.pos += 1
            lazy = True
        if high is None:
            token = "{%d,}" % low
        elif high == low:
            token = "{%d}" % low
        else:
            token = "{%d,%d}" % (low, high)
        self.apply(token, start, low, lazy)

    def decimal(self) -> int:
        """Read one decimal inside a counted repetition."""
        self.skip_space()
        begin = self.pos
        while self.peek().isdigit() and self.peek().isascii():
            self.pos += 1
        if begin == self.pos:
            raise self.fail(self.pos, self.pos, REPETITION_DECIMAL)
        digits = self.src[begin : self.pos]
        if int(digits) > 0xFFFFFFFF:
            raise self.fail(begin, self.pos, DECIMAL_INVALID)
        self.skip_space()
        return int(digits)

    def apply(self, token: str, at: int, least: int, lazy: bool) -> None:
        """Apply a repetition to the last atom.

        Args:
            token (str): the host quantifier.
            at (int): where the operator sits, for the refusal.
            least (int): its lower bound.
            lazy (bool): a ``?`` followed it.
        """
        start = self.atom_start
        if start is None:
            raise self.fail(at, at + 1, REPETITION_MISSING)
        if self.atom_assertion:
            if least == 0:
                del self.out[start:]
                self.assertion("(?:)")
            return
        body = "".join(self.out[start:])
        if self.atom_quantified or len(self.out) - start > 1:
            body = f"(?:{body})"
        if lazy != self.flags.U:
            token += "?"
        self.out[start:] = [body + token]
        self.atom_quantified = True

    def escape(self) -> None:
        """Scan one escape outside a class."""
        start = self.pos
        if self.pos + 1 >= len(self.src):
            raise self.fail(len(self.src), len(self.src), ESCAPE_EOF)
        ch = self.src[self.pos + 1]
        self.pos += 2
        if ch.isdigit() and ch.isascii():
            raise self.fail(start, self.pos, BACKREFERENCE)
        if ch == "b" and self.peek() == "{":
            close = self.src.find("}", self.pos)
            kind = self.src[self.pos + 1 : close] if close > 0 else ""
            if kind in ("start", "end", "start-half", "end-half"):
                self.pos = close + 1
                self.assertion(boundary(kind, self.flags.u))
                return
        anchors = {
            "b": "b",
            "B": "B",
            "<": "start",
            ">": "end",
        }
        if ch in anchors:
            self.assertion(boundary(anchors[ch], self.flags.u))
        elif ch == "A":
            self.assertion("\\A")
        elif ch == "z":
            self.assertion("\\Z")
        else:
            cs = self.class_escape(start, ch)
            if cs is not None:
                self.set_atom(cs)
            else:
                self.literal(self.char_escape(start, ch))

    def class_escape(self, start: int, ch: str) -> CharSet | None:
        """A class-valued escape (``\\d``, ``\\pL`` ...) or None.

        Args:
            start (int): where the backslash sits.
            ch (str): the letter after it.
        """
        u = self.flags.u
        table = {
            "d": category("Nd") if u else ASCII_DIGIT,
            "s": WHITE_SPACE if u else ASCII_SPACE,
            "w": word_class(u),
        }
        if ch.lower() in table:
            cs = table[ch.lower()]
            return cs.negate() if ch.isupper() else cs
        if ch in "pP":
            cs = self.property(start)
            return cs.negate() if ch == "P" else cs
        return None

    def property(self, start: int) -> CharSet:
        """Read the name of ``\\p`` / ``\\P`` and look it up.

        Args:
            start (int): where the backslash sits.
        """
        if self.pos >= len(self.src):
            raise self.fail(self.pos, self.pos, ESCAPE_EOF)
        if self.peek() == "{":
            close = self.src.find("}", self.pos)
            if close < 0:
                raise self.fail(len(self.src), len(self.src), ESCAPE_EOF)
            name = self.src[self.pos + 1 : close]
            self.pos = close + 1
        else:
            name = self.src[self.pos]
            self.pos += 1
        found = unicode_property(name)
        if found is None:
            raise self.fail(start, self.pos, PROPERTY_UNSUPPORTED)
        return found

    def char_escape(self, start: int, ch: str) -> int:
        """A literal-valued escape's code point.

        Args:
            start (int): where the backslash sits.
            ch (str): the character after it.
        """
        if ch in SIMPLE_ESCAPES:
            return SIMPLE_ESCAPES[ch]
        if ch in HEX_WIDTH:
            return self.hex_escape(ch)
        if ch in META_ESCAPES or (
            ch.isascii() and not ch.isalnum() and ch not in "<>"
        ):
            return ord(ch)
        raise self.fail(start, self.pos, ESCAPE_UNRECOGNIZED)

    def hex_escape(self, kind: str) -> int:
        """Read the digits of ``\\x``, ``\\u`` or ``\\U``.

        Args:
            kind (str): the escape letter.
        """
        if self.peek() == "{":
            close = self.src.find("}", self.pos)
            begin = self.pos + 1
            if close < 0:
                raise self.fail(len(self.src), len(self.src), ESCAPE_EOF)
            digits = self.src[begin:close]
            if not digits:
                raise self.fail(begin - 1, close + 1, HEX_EMPTY)
            for i, d in enumerate(digits):
                if d not in "0123456789abcdefABCDEF":
                    raise self.fail(begin + i, begin + i + 1, HEX_DIGIT)
            self.pos = close + 1
            cp = int(digits, 16)
            if cp > 0x10FFFF or 0xD800 <= cp <= 0xDFFF:
                raise self.fail(begin, close, HEX_SCALAR)
            return cp
        begin = self.pos
        for _ in range(HEX_WIDTH[kind]):
            d = self.peek()
            if not d:
                raise self.fail(len(self.src), len(self.src), ESCAPE_EOF)
            if d not in "0123456789abcdefABCDEF":
                raise self.fail(self.pos, self.pos + 1, HEX_DIGIT)
            self.pos += 1
        cp = int(self.src[begin : self.pos], 16)
        if cp > 0x10FFFF or 0xD800 <= cp <= 0xDFFF:
            raise self.fail(begin, self.pos, HEX_SCALAR)
        return cp

    def parse_class(self) -> CharSet:
        """Scan one bracketed class, nested ones and set operations too.

        Returns:
            CharSet: its members, folded under ``i`` and then negated.
        """
        open_at = self.pos
        self.pos += 1
        negated = False
        if self.peek() == "^":
            negated = True
            self.pos += 1
        opener_end = self.pos
        result: CharSet | None = None
        op: str | None = None
        current = CharSet()
        first = True
        while True:
            self.skip_space()
            if self.pos >= len(self.src):
                end = opener_end + (
                    1 if self.src[opener_end : opener_end + 1] == "]" else 0
                )
                raise self.fail(open_at, end, CLASS_UNCLOSED)
            ch = self.src[self.pos]
            if ch == "]" and not first:
                self.pos += 1
                break
            first = False
            if ch in "&-~" and self.src.startswith(ch * 2, self.pos):
                result = (
                    current if result is None else combine(result, current, op)
                )
                op = ch
                current = CharSet()
                self.pos += 2
                continue
            current = current.union(self.class_item())
        cs = current if result is None else combine(result, current, op)
        if self.flags.i:
            cs = fold(cs, not self.flags.u)
        return cs.negate() if negated else cs

    def class_item(self) -> CharSet:
        """One member of a class: a range, a char, a nested class, a
        POSIX class or a class escape."""
        ch = self.src[self.pos]
        if ch == "[":
            posix = self.posix_class()
            if posix is not None:
                return posix
            return self.parse_class()
        low_at = self.pos
        low = self.class_char()
        low_end = self.pos
        self.skip_space()
        ranged = (
            self.peek() == "-"
            and self.peek(1) not in ("]", "")
            and not self.src.startswith("--", self.pos)
        )
        if isinstance(low, CharSet):
            if ranged:
                raise self.fail(low_at, low_end, RANGE_LITERAL)
            return low
        if not ranged:
            return CharSet.chars(low)
        self.pos += 1
        self.skip_space()
        high_at = self.pos
        high = self.class_char()
        if isinstance(high, CharSet):
            raise self.fail(high_at, self.pos, RANGE_LITERAL)
        if high < low:
            raise self.fail(low_at, self.pos, RANGE_INVALID)
        return CharSet.of((low, high))

    def posix_class(self) -> CharSet | None:
        """``[:name:]`` or ``[:^name:]`` at the position, or None."""
        if not self.src.startswith("[:", self.pos):
            return None
        close = self.src.find(":]", self.pos + 2)
        if close < 0:
            return None
        name = self.src[self.pos + 2 : close]
        negated = name.startswith("^")
        cs = ASCII_CLASSES.get(name[1:] if negated else name)
        if cs is None:
            return None
        self.pos = close + 2
        return cs.negate() if negated else cs

    def class_char(self) -> int | CharSet:
        """One character (or class escape) inside a class."""
        ch = self.src[self.pos]
        if ch != "\\":
            self.pos += 1
            return ord(ch)
        start = self.pos
        if self.pos + 1 >= len(self.src):
            raise self.fail(len(self.src), len(self.src), ESCAPE_EOF)
        letter = self.src[self.pos + 1]
        self.pos += 2
        if letter.isdigit() and letter.isascii():
            raise self.fail(start, self.pos, BACKREFERENCE)
        if letter in "bBAz<>":
            raise self.fail(start, self.pos, ESCAPE_IN_CLASS)
        cs = self.class_escape(start, letter)
        if cs is not None:
            return cs
        return self.char_escape(start, letter)


def combine(left: CharSet, right: CharSet, op: str | None) -> CharSet:
    """Apply one class set operation.

    Args:
        left (CharSet): the accumulated operand.
        right (CharSet): the next operand.
        op (str | None): ``&``, ``-`` or ``~`` (the doubled operator).
    """
    if op == "&":
        return left.intersect(right)
    if op == "-":
        return left.minus(right)
    return left.xor(right)


def translate_rust(
    patterns: list[str],
    ignore_case: bool = False,
    multi_line: bool = False,
    unicode: bool = True,
) -> HostRegex:
    """Translate a ripgrep pattern list into this host's regex dialect.

    Args:
        patterns (list[str]): the patterns, one per ``-e`` or line.
        ignore_case (bool): -i, or -S over an all-lowercase pattern.
        multi_line (bool): ``^``/``$`` also match at a ``\\n`` inside
            the subject (--null-data).
        unicode (bool): Unicode mode, off under --no-unicode, the way
            a leading ``(?-u)`` turns it off.

    Returns:
        HostRegex: host source matching exactly what ripgrep's default
            engine matches, and whether the host folds case.

    Raises:
        RustRegexError: ripgrep refuses the pattern.
    """
    display = display_of(patterns)
    # The host folds Unicode letters, so only a Unicode pattern hands it
    # the folding; without Unicode the translator folds ASCII alone.
    if ignore_case and unicode and not INLINE_CASE.search(display):
        source = RustTranslator(
            display, Flags(m=multi_line, u=unicode)
        ).translate()
        return HostRegex(source, True)
    flags = Flags(i=ignore_case, m=multi_line, u=unicode)
    return HostRegex(RustTranslator(display, flags).translate())
