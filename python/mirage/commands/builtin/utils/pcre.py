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
from dataclasses import dataclass, field, replace
from functools import cache, lru_cache

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
    PCRE_HSPACE,
    PCRE_VSPACE,
    category,
    fold,
    pcre_word,
    unicode_property,
)

# PCRE2's compile error texts (pcre2_error.c, 10.43 and 10.46 agree on
# every one used here), which grep prints after `grep: ` and ripgrep
# after `rg: PCRE2: error compiling pattern at offset N: `.
MISSING_PAREN = "missing closing parenthesis"
UNMATCHED_PAREN = "unmatched closing parenthesis"
MISSING_BRACKET = "missing terminating ] for character class"
TRAILING_BACKSLASH = "\\ at end of pattern"
TRAILING_C = "\\c at end of pattern"
NOTHING_TO_REPEAT = "quantifier does not follow a repeatable item"
QUANTIFIER_ORDER = "numbers out of order in {} quantifier"
QUANTIFIER_BIG = "number too big in {} quantifier"
LOOKBEHIND_UNLIMITED = "length of lookbehind assertion is not limited"
UNKNOWN_PROPERTY = "unknown property after \\P or \\p"
MALFORMED_PROPERTY = "malformed \\P or \\p sequence"
N_IN_CLASS = "\\N is not supported in a class"
NO_SUBPATTERN = "reference to non-existent subpattern"
BAD_GROUP_SYNTAX = "unrecognized character after (? or (?-"
CODE_POINT_BIG = "character code point value in \\x{} or \\o{} is too large"
RANGE_BAD = "invalid range in character class"
RANGE_ORDER = "range out of order in character class"
POSIX_UNKNOWN = "unknown POSIX class name"
HEX_BAD = "non-hex character in \\x{} (closing brace missing?)"
OCTAL_BAD = "non-octal character in \\o{} (closing brace missing?)"
DIGITS_MISSING = "digits missing after \\x or in \\x{} or \\o{} or \\N{U+}"
ESCAPE_UNKNOWN = "unrecognized character follows \\"
NAME_EXPECTED = "subpattern name expected"
NAME_UNTERMINATED = "syntax error in subpattern name (missing terminator?)"
NAME_DIGIT = "subpattern name must start with a non-digit"
NAME_DUPLICATE = (
    "two named subpatterns have the same name (PCRE2_DUPNAMES not set)"
)
COMMENT_UNTERMINATED = "missing ) after (?# comment"
KEEP_IN_LOOKAROUND = (
    "\\K is not allowed in lookarounds "
    "(but see PCRE2_EXTRA_ALLOW_LOOKAROUND_BSK)"
)
NAMED_CHAR_UTF = "\\N{U+dddd} is supported only in Unicode (UTF) mode"
CASE_ESCAPES = "PCRE2 does not support \\F, \\L, \\l, \\N{name}, \\U, or \\u"
ESCAPE_IN_CLASS = "escape sequence is invalid in character class"
G_SYNTAX = (
    "\\g is not followed by a braced, angle-bracketed, or quoted "
    "name/number or by a plain number"
)
K_SYNTAX = "\\k is not followed by a braced, angle-bracketed, or quoted name"

# What mirage refuses although PCRE2 accepts it: nothing on either host
# engine can mean the same, so the pattern is refused rather than run as
# something else.

# The reserved group names synthetic groups use. A `\K` is an empty group
# whose position becomes the reported match start (`match_start`); an
# atomic group is emulated with a captured lookahead on a host without
# one. Consumers that number groups skip both (`user_group`).
KEEP_PREFIX = "mirage_keep_"
ATOMIC_PREFIX = "mirage_atomic_"
SYNTHETIC_PREFIX = "mirage_"

FLAG_LETTERS = "imnsxJU"
HEX = "0123456789abcdefABCDEF"
NAME_START = re.compile(r"[A-Za-z_]")
NAME_CHARS = re.compile(r"[A-Za-z0-9_]*")
INTERVAL = re.compile(r"\{[ \t]*([0-9]*)[ \t]*(,[ \t]*([0-9]*)[ \t]*)?\}")
DIGITS = re.compile(r"[0-9]*")
OCTAL_TAIL = re.compile(r"[0-7]{0,2}")
HEX_PAIR = re.compile(r"[0-9a-fA-F]{0,2}")
G_REFERENCE = re.compile(
    r"\{(-?[0-9]+)\}|(-?[0-9]+)|\{([A-Za-z_][A-Za-z0-9_]*)\}"
)
K_REFERENCE = re.compile(
    r"<([A-Za-z_][A-Za-z0-9_]*)>|'([A-Za-z_][A-Za-z0-9_]*)'"
    r"|\{([A-Za-z_][A-Za-z0-9_]*)\}"
)
GROUP_NAMES = re.compile(
    r"\(\?(?:P?<([A-Za-z_][A-Za-z0-9_]*)>"
    r"|'([A-Za-z_][A-Za-z0-9_]*)')"
)
# An inline option group that could change case sensitivity (or, with
# `x`, what the text of the pattern is): a caseless pattern without one is
# caseless throughout, and the host engine folds it.
INLINE_CASE = re.compile(r"\(\?[\^a-zA-Z-]*[i^]")
POSIX_NAME = re.compile(r"\^?[a-z<>]+")
BACKREF_MARK = "\x00{}\x00"
SIMPLE_ESCAPES = {
    "a": 0x07,
    "e": 0x1B,
    "f": 0x0C,
    "n": 0x0A,
    "r": 0x0D,
    "t": 0x09,
}
UCP_POSIX = {
    "alpha": ("L",),
    "alnum": ("L", "N"),
    "digit": ("Nd",),
    "lower": ("Ll",),
    "upper": ("Lu",),
    "cntrl": ("Cc",),
}
GRAPH_EXCLUDED = CharSet.of(
    (0x061C, 0x061C), (0x180E, 0x180E), (0x2066, 0x2069)
)
NEWLINE_SEQUENCE = CharSet.of((0x0A, 0x0D), (0x85, 0x85), (0x2028, 0x2029))


class PcreError(Exception):
    """A pattern PCRE2 (or mirage's reading of it) refuses.

    Args:
        message (str): PCRE2's error text.
        offset (int): where in the compiled pattern PCRE2 reports it.
    """

    def __init__(self, message: str, offset: int) -> None:
        self.message = message
        self.offset = offset
        super().__init__(message)


@dataclass(frozen=True, slots=True)
class Flags:
    """The option letters in force at one point.

    Args:
        i (bool): caseless.
        m (bool): multiline anchors.
        n (bool): plain parentheses do not capture.
        s (bool): ``.`` matches newline.
        x (bool): extended: whitespace and ``#`` comments ignored.
        xx (bool): ``x`` inside classes too.
        U (bool): ungreedy.
    """

    i: bool = False
    m: bool = False
    n: bool = False
    s: bool = False
    x: bool = False
    xx: bool = False
    U: bool = False


@dataclass(slots=True)
class Frame:
    """One open group.

    Args:
        open_at (int): where its ``(`` sits.
        out_start (int): where its source begins in ``out``.
        flags (Flags): the flags in force before it opened.
        kind (str): ``group``, ``ahead``, ``behind`` or ``atomic``.
        negative (bool): a negative lookaround.
        branches (list[int]): where each alternative starts in ``out``.
        widths (list[tuple[int, int | None]]): each finished branch's
            (least, most) length, ``None`` when unbounded.
        low (int): the current branch's least length so far.
        high (int | None): its most, ``None`` when unbounded.
        atomic (int): the synthetic group number of an emulated atomic
            group, else 0.
    """

    open_at: int
    out_start: int
    flags: Flags
    kind: str = "group"
    negative: bool = False
    branches: list[int] = field(default_factory=list)
    widths: list[tuple[int, int | None]] = field(default_factory=list)
    low: int = 0
    high: int | None = 0
    atomic: int = 0


def unsupported(what: str) -> str:
    return f"{what} is not supported in mirage"


def add_width(
    a: tuple[int, int | None], b: tuple[int, int | None]
) -> tuple[int, int | None]:
    """Two lengths in sequence.

    Args:
        a (tuple[int, int | None]): one (least, most).
        b (tuple[int, int | None]): the other.
    """
    high = None if a[1] is None or b[1] is None else a[1] + b[1]
    return a[0] + b[0], high


class PcreTranslator:
    """A PCRE2 pattern re-emitted in this host's dialect.

    One scan that refuses what PCRE2 refuses, in its words and at its
    offsets, and emits what it accepts without leaning on any host
    shorthand whose meaning differs: ``\\d \\w \\s \\h \\v`` and POSIX
    classes are explicit sets (ASCII for grep, which runs PCRE2 without
    UCP; Unicode for rg, which sets it), case folding is applied to each
    literal and class, ``\\K`` is a marker group, and lookbehind is
    split into fixed-length alternatives, the only kind python's engine
    reads. Mirrored in ``pcre.ts``.

    Args:
        pattern (str): the pattern as PCRE2 compiles it.
        unicode (bool): UTF with UCP (ripgrep) rather than grep's
            default C-locale reading, in which the classes are ASCII and
            ``\\N{U+...}`` is refused. Either way mirage matches code
            points, not bytes: ``\\x{00a0}`` is the no-break space.
        flags (Flags): the options in force at the start.
    """

    def __init__(self, pattern: str, unicode: bool, flags: Flags) -> None:
        self.src = pattern
        self.unicode = unicode
        self.pos = 0
        self.flags = flags
        self.out: list[str] = []
        self.atom_start: int | None = None
        self.atom_width: tuple[int, int | None] = (0, 0)
        self.repeatable = False
        self.quantified = False
        self.look = False
        self.stack: list[Frame] = [Frame(0, 0, flags)]
        self.total_groups = count_groups(pattern)
        self.groups = 0
        self.host_groups = 0
        self.group_map: dict[int, int] = {}
        self.names: set[str] = set()
        self.keeps = 0
        self.atomics = 0
        self.caseless_backref = False
        self.case_sensitive_text = False
        self.backrefs: list[tuple[int, int]] = []

    def fail(self, message: str, offset: int | None = None) -> PcreError:
        """An error at ``offset`` (default: the current position).

        Args:
            message (str): PCRE2's text.
            offset (int | None): where PCRE2 reports it.
        """
        return PcreError(message, self.pos if offset is None else offset)

    def peek(self, offset: int = 0) -> str:
        """The character ``offset`` past the position, or empty.

        Args:
            offset (int): how far ahead.
        """
        return self.src[self.pos + offset : self.pos + offset + 1]

    def translate(self) -> HostRegex:
        """Scan the whole pattern.

        Raises:
            PcreError: PCRE2 or mirage refuses it.
        """
        while True:
            self.skip_space()
            if self.pos >= len(self.src):
                break
            self.step()
        if len(self.stack) > 1:
            raise self.fail(MISSING_PAREN, len(self.src))
        source = "".join(self.out)
        for index, (number, offset) in enumerate(self.backrefs):
            host = self.group_map.get(number)
            if host is None:
                raise self.fail(NO_SUBPATTERN, offset)
            source = source.replace(
                BACKREF_MARK.format(index), f"(?:\\{host})"
            )
        if self.caseless_backref and self.case_sensitive_text:
            raise self.fail(
                unsupported(
                    "a caseless back-reference in a case-sensitive pattern"
                ),
                0,
            )
        return HostRegex(source, self.caseless_backref)

    def skip_space(self) -> None:
        """Skip whitespace and ``#`` comments under ``x``."""
        while self.flags.x and self.pos < len(self.src):
            ch = self.src[self.pos]
            if ch in " \t\n\r\f\v":
                self.pos += 1
            elif ch == "#":
                end = self.src.find("\n", self.pos)
                self.pos = len(self.src) if end < 0 else end + 1
            else:
                return

    def step(self) -> None:
        """Scan one token."""
        ch = self.src[self.pos]
        if ch == "(":
            self.open_group()
        elif ch == ")":
            self.close_group()
        elif ch == "|":
            self.pos += 1
            self.alternate()
        elif self.src.startswith(("[[:<:]]", "[[:>:]]"), self.pos):
            start = self.src[self.pos + 3] == "<"
            self.pos += 7
            self.assertion(word_edge(start, self.unicode))
        elif ch == "[":
            self.atom(host_class(self.parse_class()), (1, 1))
        elif ch in "*+?":
            self.quantifier(ch)
        elif ch == "{" and self.interval_at(self.pos) is not None:
            self.quantifier(ch)
        elif ch == "\\":
            self.escape()
        elif ch == ".":
            self.pos += 1
            self.atom(
                host_class(
                    ALL if self.flags.s else ALL.minus(CharSet.chars(0x0A))
                ),
                (1, 1),
            )
        elif ch == "^":
            self.pos += 1
            self.assertion("(?:^|(?<=\\n))" if self.flags.m else "^")
        elif ch == "$":
            self.pos += 1
            self.assertion("(?=\\n|\\Z)" if self.flags.m else "(?=\\n?\\Z)")
        else:
            self.pos += 1
            self.literal(ord(ch))

    def atom(self, text: str, width: tuple[int, int | None]) -> None:
        """Emit one repeatable atom.

        Args:
            text (str): its host source.
            width (tuple[int, int | None]): its (least, most) length.
        """
        self.atom_start = len(self.out)
        self.out.append(text)
        self.atom_width = width
        self.repeatable = True
        self.quantified = False
        self.look = False
        frame = self.stack[-1]
        frame.low, frame.high = add_width((frame.low, frame.high), width)

    def assertion(self, text: str) -> None:
        """Emit one zero-width assertion, which no quantifier may follow.

        Args:
            text (str): its host source.
        """
        self.out.append(text)
        self.atom_start = None
        self.repeatable = False

    def literal(self, cp: int) -> None:
        """Emit one literal code point, folded when caseless.

        Args:
            cp (int): the code point.
        """
        folded = fold(CharSet.chars(cp), not self.unicode)
        if folded.single() is None:
            if self.flags.i:
                self.atom(host_class(folded), (1, 1))
                return
            self.case_sensitive_text = True
        self.atom(host_char(cp), (1, 1))

    def set_atom(self, cs: CharSet) -> None:
        """Emit a class-valued escape, folded when caseless.

        Args:
            cs (CharSet): its members.
        """
        self.atom(host_class(self.caseless(cs)), (1, 1))

    def caseless(self, cs: CharSet) -> CharSet:
        """A set folded when ``i`` is in force.

        Args:
            cs (CharSet): the set.
        """
        if not self.flags.i:
            if fold(cs, not self.unicode) != cs:
                self.case_sensitive_text = True
            return cs
        return fold(cs, not self.unicode)

    def alternate(self) -> None:
        """Start the next alternative of the innermost group."""
        frame = self.stack[-1]
        frame.widths.append((frame.low, frame.high))
        frame.low, frame.high = 0, 0
        self.out.append("|")
        frame.branches.append(len(self.out))
        self.atom_start = None
        self.repeatable = False

    def open_group(self) -> None:
        """Scan a ``(`` and the group syntax after it."""
        start = self.pos
        src = self.src
        if src.startswith("(*", start):
            self.verb(start)
            return
        self.pos += 1
        if self.peek() != "?":
            if self.flags.n:
                self.push(start, "(?:", "group")
            else:
                self.capture(start, "")
            return
        self.pos += 1
        ch = self.peek()
        if not ch:
            raise self.fail(MISSING_PAREN, len(src))
        rest = src[self.pos :]
        if rest.startswith(("<=", "<!")):
            self.pos += 2
            self.push(
                start,
                "(?<=" if ch == "<" and rest[1] == "=" else "(?<!",
                "behind",
                rest[1] == "!",
            )
            return
        if ch in "=!":
            self.pos += 1
            self.push(start, "(?" + ch, "ahead", ch == "!")
            return
        if ch == "<" or ch == "'" or rest.startswith("P<"):
            self.pos += 2 if ch == "P" else 1
            self.capture(start, self.group_name(">" if ch != "'" else "'"))
            return
        if ch == ":":
            self.pos += 1
            self.push(start, "(?:", "group")
            return
        if ch == ">":
            self.pos += 1
            self.open_atomic(start)
            return
        if ch == "#":
            close = src.find(")", self.pos)
            if close < 0:
                raise self.fail(COMMENT_UNTERMINATED, len(src))
            self.pos = close + 1
            return
        if ch == "C":
            close = src.find(")", self.pos)
            if close < 0:
                raise self.fail(MISSING_PAREN, len(src))
            self.pos = close + 1
            return
        if rest.startswith("P=") or rest.startswith("P>"):
            if rest.startswith("P>"):
                raise self.fail(unsupported("(?P>name) recursion"), start)
            self.pos += 2
            close = src.find(")", self.pos)
            if close < 0:
                raise self.fail(NAME_UNTERMINATED, len(src))
            name = src[self.pos : close]
            at = self.pos
            self.pos = close + 1
            self.named_backref(name, at)
            return
        if ch == "|":
            raise self.fail(unsupported("(?| branch reset"), start)
        if ch == "(":
            raise self.fail(unsupported("(?( conditional group"), start)
        if (
            ch in "R&+"
            or ch.isdigit()
            or (ch == "-" and self.peek(1).isdigit())
        ):
            raise self.fail(unsupported("recursion"), start)
        if ch == "*":
            raise self.fail(unsupported("(?* non-atomic lookaround"), start)
        self.inline_flags(start)

    def verb(self, start: int) -> None:
        """A ``(*...)`` item: a start-of-pattern option or a verb.

        Args:
            start (int): where the ``(`` sits.
        """
        close = self.src.find(")", start)
        if close < 0:
            raise self.fail(MISSING_PAREN, len(self.src))
        name = self.src[start + 2 : close]
        if start == 0 or self.out == []:
            if name in (
                "UTF",
                "UTF8",
                "UCP",
                "NO_JIT",
                "NO_START_OPT",
                "NO_AUTO_POSSESS",
                "NO_DOTSTAR_ANCHOR",
            ):
                self.pos = close + 1
                return
        raise self.fail(unsupported(f"(*{name})"), start)

    def capture(self, start: int, name: str) -> None:
        """Open a capturing group.

        Args:
            start (int): where the ``(`` sits.
            name (str): its name, or empty.
        """
        self.groups += 1
        self.host_groups += 1
        self.group_map[self.groups] = self.host_groups
        if name:
            self.group_map_name(name)
        self.push(start, f"(?P<{name}>" if name else "(", "group")

    def group_map_name(self, name: str) -> None:
        """Record a group name, refusing a duplicate.

        Args:
            name (str): the name.
        """
        if name in self.names:
            raise self.fail(NAME_DUPLICATE)
        self.names.add(name)

    def group_name(self, terminator: str) -> str:
        """Read a group name through its terminator.

        Args:
            terminator (str): ``>`` or ``'``.
        """
        begin = self.pos
        if self.pos >= len(self.src) or self.peek() == terminator:
            raise self.fail(NAME_EXPECTED)
        if self.peek().isdigit():
            raise self.fail(NAME_DIGIT)
        if not NAME_START.match(self.peek()):
            raise self.fail(NAME_EXPECTED)
        found = NAME_CHARS.match(self.src, begin)
        assert found is not None
        self.pos = found.end()
        if self.peek() != terminator:
            raise self.fail(NAME_UNTERMINATED)
        self.pos += 1
        return self.src[begin : found.end()]

    def push(
        self, start: int, opener: str, kind: str, negative: bool = False
    ) -> None:
        """Open a group whose host opener is ``opener``.

        Args:
            start (int): where the ``(`` sits.
            opener (str): the host text.
            kind (str): ``group``, ``ahead``, ``behind`` or ``atomic``.
            negative (bool): a negative lookaround.
        """
        frame = Frame(start, len(self.out), self.flags, kind, negative)
        self.stack.append(frame)
        self.out.append(opener)
        frame.branches.append(len(self.out))
        self.atom_start = None
        self.repeatable = False

    def open_atomic(self, start: int) -> None:
        """Open ``(?>``, the host's own atomic group.

        Args:
            start (int): where the ``(`` sits.
        """
        self.push(start, "(?>", "atomic")

    def inline_flags(self, start: int) -> None:
        """Read ``(?flags)`` or ``(?flags:``, the position past ``(?``.

        Args:
            start (int): where the ``(`` sits.
        """
        flags = self.flags
        on = True
        if self.peek() == "^":
            flags = replace(
                flags, i=False, m=False, n=False, s=False, x=False, xx=False
            )
            self.pos += 1
        while True:
            if self.pos >= len(self.src):
                raise self.fail(MISSING_PAREN, len(self.src))
            ch = self.src[self.pos]
            self.pos += 1
            if ch in ":)":
                break
            if ch == "-" and on:
                on = False
                continue
            if ch not in FLAG_LETTERS:
                raise self.fail(BAD_GROUP_SYNTAX, self.pos - 1)
            if ch == "J":
                continue
            if ch == "x" and self.peek() == "x":
                self.pos += 1
                flags = replace(flags, x=on, xx=on)
                continue
            flags = replace(flags, **{ch: on})
        if ch == ":":
            self.push(start, "(?:", "group")
        else:
            self.atom_start = None
            self.repeatable = False
        self.flags = flags

    def close_group(self) -> None:
        """Scan a ``)``."""
        if len(self.stack) == 1:
            raise self.fail(UNMATCHED_PAREN)
        frame = self.stack.pop()
        self.pos += 1
        frame.widths.append((frame.low, frame.high))
        self.flags = frame.flags
        if frame.kind == "behind":
            self.close_lookbehind(frame)
            return
        self.out.append(")")
        if frame.kind == "atomic" and frame.atomic:
            self.out.append(f"(?P={ATOMIC_PREFIX}{frame.atomic})")
        if frame.kind == "ahead":
            self.out[frame.out_start :] = [
                "".join(self.out[frame.out_start :])
            ]
            self.atom_start = frame.out_start
            self.atom_width = (0, 0)
            self.repeatable = True
            self.quantified = False
            self.look = True
            return
        lows = [w[0] for w in frame.widths]
        highs = [w[1] for w in frame.widths]
        width = (
            min(lows),
            None if None in highs else max(h for h in highs if h is not None),
        )
        self.out[frame.out_start :] = ["".join(self.out[frame.out_start :])]
        self.atom_start = frame.out_start
        self.atom_width = width
        self.repeatable = True
        self.quantified = False
        self.look = False
        parent = self.stack[-1]
        parent.low, parent.high = add_width((parent.low, parent.high), width)

    def close_lookbehind(self, frame: Frame) -> None:
        """Close ``(?<=`` / ``(?<!`` as fixed-length host lookbehinds.

        PCRE2 10.43 accepts a bounded lookbehind whose alternatives
        differ in length; python's engine takes one fixed length per
        lookbehind, so each alternative becomes its own, joined with
        ``|`` for a positive assertion and in sequence for a negative
        one. An alternative that is itself variable is refused.

        Args:
            frame (Frame): the lookbehind's frame.
        """
        for low, high in frame.widths:
            if high is None:
                raise self.fail(LOOKBEHIND_UNLIMITED, frame.open_at)
            if low != high:
                raise self.fail(
                    unsupported("a variable-length lookbehind"),
                    frame.open_at,
                )
        bodies = []
        edges = [*frame.branches, len(self.out) + 1]
        for i, begin in enumerate(frame.branches):
            bodies.append("".join(self.out[begin : edges[i + 1] - 1]))
        opener = "(?<!" if frame.negative else "(?<="
        if len(bodies) == 1:
            text = opener + bodies[0] + ")"
        elif frame.negative:
            text = "".join(opener + b + ")" for b in bodies)
        else:
            text = "(?:" + "|".join(opener + b + ")" for b in bodies) + ")"
        self.out[frame.out_start :] = [text]
        self.atom_start = None
        self.repeatable = False

    def quantifier(self, op: str) -> None:
        """Scan a quantifier and its lazy or possessive suffix.

        Args:
            op (str): ``*``, ``+``, ``?`` or ``{``.
        """
        at = self.pos
        if op == "{":
            interval = self.interval_at(self.pos)
            assert interval is not None
            low, high, end = interval
            self.pos = end
            at = end - 1
            token = (
                "{%d}" % low
                if high == low
                else "{%d,}" % low
                if high is None
                else "{%d,%d}" % (low, high)
            )
        else:
            self.pos += 1
            low, high = {"*": (0, None), "+": (1, None), "?": (0, 1)}[op]
            token = op
        if not self.repeatable or self.quantified or self.atom_start is None:
            raise self.fail(NOTHING_TO_REPEAT, at)
        suffix = ""
        if self.peek() in ("?", "+"):
            suffix = self.peek()
            self.pos += 1
        if suffix == "" and self.flags.U:
            suffix = "?"
        elif suffix == "?" and self.flags.U:
            suffix = ""
        start = self.atom_start
        if self.look:
            if low == 0:
                del self.out[start:]
            self.repeatable = False
            return
        body = "".join(self.out[start:])
        if len(self.out) - start > 1:
            body = f"(?:{body})"
        width = self.atom_width
        frame = self.stack[-1]
        frame.low -= width[0]
        if frame.high is not None and width[1] is not None:
            frame.high -= width[1]
        least = width[0] * low
        most = None if high is None or width[1] is None else width[1] * high
        if high is None and width[1] == 0:
            most = 0
        frame.low, frame.high = add_width(
            (frame.low, frame.high), (least, most)
        )
        self.out[start:] = [
            self.possessive(body, token)
            if suffix == "+"
            else body + token + suffix
        ]
        self.quantified = True
        self.atom_width = (least, most)

    def possessive(self, body: str, token: str) -> str:
        """A possessive quantifier as the host spells it.

        Args:
            body (str): the repeated atom's host source.
            token (str): the host quantifier.
        """
        return body + token + "+"

    def interval_at(self, i: int) -> tuple[int, int | None, int] | None:
        """A ``{n}``, ``{n,}``, ``{n,m}`` or ``{,m}`` quantifier at ``i``.

        Args:
            i (int): where the ``{`` sits.

        Returns:
            tuple[int, int | None, int] | None: the bounds and the index
                past the ``}``, or None when the brace is a literal.

        Raises:
            PcreError: the bounds are out of order or too big.
        """
        found = INTERVAL.match(self.src, i)
        if found is None:
            return None
        low_text, comma, high_text = (
            found.group(1),
            found.group(2),
            found.group(3),
        )
        if not low_text and not (comma and high_text):
            return None
        low = int(low_text) if low_text else 0
        high = (
            low if comma is None else (int(high_text) if high_text else None)
        )
        for value in (low, high):
            if value is not None and value > 65535:
                raise self.fail(QUANTIFIER_BIG, found.end() - 1)
        if high is not None and high < low:
            raise self.fail(QUANTIFIER_ORDER, found.end() - 1)
        return low, high, found.end()

    def escape(self) -> None:
        """Scan one escape outside a class."""
        start = self.pos
        if self.pos + 1 >= len(self.src):
            raise self.fail(TRAILING_BACKSLASH, len(self.src))
        ch = self.src[self.pos + 1]
        self.pos += 2
        if ch == "Q":
            end = self.src.find("\\E", self.pos)
            text = (
                self.src[self.pos :] if end < 0 else self.src[self.pos : end]
            )
            self.pos = len(self.src) if end < 0 else end + 2
            for c in text:
                self.literal(ord(c))
            return
        if ch == "E":
            return
        if ch == "K":
            self.keep()
            return
        if ch == "G":
            raise self.fail(unsupported("\\G"), start)
        if ch in "XC":
            raise self.fail(unsupported("\\" + ch), start)
        if ch == "R":
            self.atom(
                "(?:\\r\\n|" + host_class(NEWLINE_SEQUENCE) + ")", (1, 2)
            )
            return
        if ch == "b":
            self.assertion(boundary(True, self.unicode))
            return
        if ch == "B":
            self.assertion(boundary(False, self.unicode))
            return
        if ch == "A":
            self.assertion("\\A")
            return
        if ch == "z":
            self.assertion("\\Z")
            return
        if ch == "Z":
            self.assertion("(?=\\n?\\Z)")
            return
        if ch == "N" and self.peek() == "{":
            self.named_char()
            return
        if ch in "gk" or ch.isdigit() and ch != "0":
            if self.reference(start, ch):
                return
        cs = self.class_escape(ch)
        if cs is not None:
            self.set_atom(cs)
            return
        self.literal(self.char_escape(ch, False))

    def named_char(self) -> None:
        """``\\N{U+hhhh}``, which only a UTF pattern may spell."""
        if not self.unicode:
            raise self.fail(NAMED_CHAR_UTF)
        close = self.src.find("}", self.pos)
        body = self.src[self.pos + 1 : close] if close > 0 else ""
        if not body.startswith("U+"):
            raise self.fail(CASE_ESCAPES)
        digits = body[2:]
        if not digits or any(d not in HEX for d in digits):
            raise self.fail(DIGITS_MISSING)
        self.pos = close + 1
        self.literal(self.code_point(int(digits, 16), close))

    def keep(self) -> None:
        """``\\K``: an empty marker group, refused inside a lookaround."""
        if any(f.kind in ("ahead", "behind") for f in self.stack):
            raise self.fail(KEEP_IN_LOOKAROUND, len(self.src))
        self.host_groups += 1
        self.out.append(f"(?P<{KEEP_PREFIX}{self.keeps}>)")
        self.keeps += 1
        self.atom_start = None
        self.repeatable = False

    def reference(self, start: int, ch: str) -> bool:
        """A back-reference, or False when ``\\ddd`` is an octal escape.

        Args:
            start (int): where the backslash sits.
            ch (str): the letter or first digit after it.
        """
        src = self.src
        if ch.isdigit():
            digits = DIGITS.match(src, self.pos)
            assert digits is not None
            number = int(ch + digits.group())
            if number >= 10 and number > self.total_groups:
                if ch in "89":
                    raise self.fail(NO_SUBPATTERN, digits.end())
                return False
            self.pos = digits.end()
            self.backref(number, self.pos - 1)
            return True
        if ch == "g":
            found = G_REFERENCE.match(src, self.pos)
            if found is None:
                if src[self.pos : self.pos + 1] in ("<", "'"):
                    raise self.fail(unsupported("subroutine calls"), start)
                raise self.fail(G_SYNTAX)
            self.pos = found.end()
            if found.group(3):
                self.named_backref(found.group(3), found.start(3))
                return True
            number = int(found.group(1) or found.group(2))
            if number < 0:
                number = self.groups + 1 + number
            if number <= 0:
                raise self.fail(NO_SUBPATTERN, self.pos)
            self.backref(number, self.pos - 1)
            return True
        found = K_REFERENCE.match(src, self.pos)
        if found is None:
            raise self.fail(K_SYNTAX)
        self.pos = found.end()
        self.named_backref(
            found.group(1) or found.group(2) or found.group(3),
            self.pos - len(found.group()) + 1,
        )
        return True

    def backref(self, number: int, offset: int) -> None:
        """Emit a numbered back-reference, resolved once every group is.

        Args:
            number (int): the group as the pattern numbers it.
            offset (int): where PCRE2 reports a missing group.
        """
        if self.flags.i:
            self.caseless_backref = True
        self.atom(BACKREF_MARK.format(len(self.backrefs)), (0, None))
        self.backrefs.append((number, offset))

    def named_backref(self, name: str, at: int) -> None:
        """Emit a back-reference by name.

        Args:
            name (str): the group name.
            at (int): where the name starts, where PCRE2 reports a
                missing group.
        """
        if name not in self.names and name not in named_groups(self.src):
            raise self.fail(NO_SUBPATTERN, at)
        if self.flags.i:
            self.caseless_backref = True
        self.atom(f"(?P={name})", (0, None))

    def class_escape(self, ch: str) -> CharSet | None:
        """A class-valued escape (``\\d``, ``\\h``, ``\\pL`` ...) or None.

        Args:
            ch (str): the letter after it.
        """
        if ch == "N":
            return ALL.minus(CharSet.chars(0x0A))
        table = {
            "d": category("Nd") if self.unicode else ASCII_DIGIT,
            "s": (
                PCRE_HSPACE.union(PCRE_VSPACE) if self.unicode else ASCII_SPACE
            ),
            "w": pcre_word() if self.unicode else ASCII_WORD,
            "h": PCRE_HSPACE,
            "v": PCRE_VSPACE,
        }
        if ch.lower() in table:
            cs = table[ch.lower()]
            return cs.negate() if ch.isupper() else cs
        if ch in "pP":
            cs = self.property()
            return cs.negate() if ch == "P" else cs
        return None

    def property(self) -> CharSet:
        """Read the name of ``\\p`` / ``\\P`` and look it up."""
        if self.peek() == "{":
            close = self.src.find("}", self.pos)
            if close < 0:
                raise self.fail(UNKNOWN_PROPERTY, len(self.src))
            name = self.src[self.pos + 1 : close]
            self.pos = close + 1
        elif self.pos < len(self.src):
            name = self.src[self.pos]
            self.pos += 1
            if not name.isalpha():
                raise self.fail(MALFORMED_PROPERTY)
        else:
            raise self.fail(MALFORMED_PROPERTY, len(self.src))
        negated = name.startswith("^")
        cs = pcre_property(name[1:] if negated else name)
        if cs is None:
            raise self.fail(unsupported(f"\\p{{{name}}}"))
        return cs.negate() if negated else cs

    def char_escape(self, ch: str, in_class: bool) -> int:
        """A literal-valued escape's code point.

        Args:
            ch (str): the character after it.
            in_class (bool): inside a bracket expression, where ``\\b``
                is a backspace.
        """
        src = self.src
        if ch in SIMPLE_ESCAPES:
            return SIMPLE_ESCAPES[ch]
        if in_class and ch == "b":
            return 0x08
        if ch == "c":
            if self.pos >= len(src):
                raise self.fail(TRAILING_C, len(src))
            letter = src[self.pos]
            self.pos += 1
            return ord(letter.upper()) ^ 0x40
        if ch == "x":
            return self.hex_escape()
        if ch == "o":
            if self.peek() != "{":
                raise self.fail(DIGITS_MISSING)
            close = src.find("}", self.pos)
            digits = src[self.pos + 1 : close] if close > 0 else ""
            if (
                close < 0
                or not digits
                or any(d not in "01234567" for d in digits)
            ):
                raise self.fail(
                    OCTAL_BAD if digits or close < 0 else DIGITS_MISSING,
                    self.pos + 1 + first_outside(digits, "01234567"),
                )
            self.pos = close + 1
            return self.code_point(int(digits, 8), close)
        if ch.isdigit():
            found = OCTAL_TAIL.match(src, self.pos)
            assert found is not None
            if ch in "89":
                return ord(ch)
            self.pos = found.end()
            return int(ch + found.group(), 8)
        if ch in "LlUu" or (ch == "N" and self.peek() == "{"):
            raise self.fail(CASE_ESCAPES)
        if ch.isascii() and ch.isalnum():
            raise self.fail(ESCAPE_UNKNOWN, self.pos - 1)
        return ord(ch)

    def hex_escape(self) -> int:
        """Read the digits of ``\\x``."""
        src = self.src
        if self.peek() == "{":
            close = src.find("}", self.pos)
            digits = src[self.pos + 1 : close] if close > 0 else ""
            if close < 0 or any(d not in HEX for d in digits):
                raise self.fail(
                    HEX_BAD, self.pos + 1 + first_outside(digits, HEX)
                )
            if not digits:
                raise self.fail(DIGITS_MISSING)
            self.pos = close + 1
            return self.code_point(int(digits, 16), close)
        found = HEX_PAIR.match(src, self.pos)
        assert found is not None
        if not found.group():
            raise self.fail(DIGITS_MISSING)
        self.pos = found.end()
        return int(found.group(), 16)

    def code_point(self, value: int, offset: int) -> int:
        """A numeric escape's value, refused past the code space.

        Args:
            value (int): the value.
            offset (int): where PCRE2 reports an overflow.
        """
        limit = 0x10FFFF if self.unicode else 0xFF
        if value > limit or (self.unicode and 0xD800 <= value <= 0xDFFF):
            raise self.fail(CODE_POINT_BIG, offset)
        return value

    def parse_class(self) -> CharSet:
        """Scan one bracket expression.

        Returns:
            CharSet: its members, folded when caseless, then negated.
        """
        src = self.src
        self.pos += 1
        negated = False
        if self.peek() == "^":
            negated = True
            self.pos += 1
        cs = CharSet()
        first = True
        while True:
            if self.flags.xx:
                while self.peek() in (" ", "\t"):
                    self.pos += 1
            if self.pos >= len(src):
                raise self.fail(MISSING_BRACKET, len(src))
            ch = src[self.pos]
            if ch == "]" and not first:
                self.pos += 1
                break
            first = False
            if src.startswith("\\Q", self.pos):
                end = src.find("\\E", self.pos + 2)
                text = (
                    src[self.pos + 2 :] if end < 0 else src[self.pos + 2 : end]
                )
                self.pos = len(src) if end < 0 else end + 2
                cs = cs.union(CharSet.chars(*(ord(c) for c in text)))
                continue
            if src.startswith("\\E", self.pos):
                self.pos += 2
                continue
            posix = self.posix_class()
            if posix is not None:
                cs = cs.union(posix)
                continue
            low = self.class_char()
            ranged = self.peek() == "-" and self.peek(1) not in ("]", "")
            if isinstance(low, CharSet):
                if ranged and not src.startswith("\\E", self.pos + 1):
                    raise self.fail(RANGE_BAD, self.pos + 1)
                cs = cs.union(low)
                continue
            if not ranged:
                cs = cs.union(CharSet.chars(low))
                continue
            self.pos += 1
            if (
                src.startswith("[:", self.pos)
                and self.posix_name() is not None
            ):
                raise self.fail(RANGE_BAD, self.pos)
            high = self.class_char()
            if isinstance(high, CharSet):
                raise self.fail(RANGE_BAD, self.pos - 1)
            if high < low:
                raise self.fail(RANGE_ORDER, self.pos - 1)
            cs = cs.union(CharSet.of((low, high)))
        cs = self.caseless(cs)
        return cs.negate() if negated else cs

    def posix_name(self) -> str | None:
        """The name of a ``[:name:]`` at the position, or None."""
        close = self.src.find(":]", self.pos + 2)
        if close < 0:
            return None
        name = self.src[self.pos + 2 : close]
        if not POSIX_NAME.fullmatch(name):
            return None
        return name

    def posix_class(self) -> CharSet | None:
        """``[:name:]`` or ``[:^name:]`` at the position, or None."""
        if not self.src.startswith("[:", self.pos):
            return None
        name = self.posix_name()
        if name is None:
            return None
        negated = name.startswith("^")
        bare = name[1:] if negated else name
        if bare in ("<", ">"):
            raise self.fail(unsupported(f"[[:{bare}:]]"), self.pos)
        cs = posix_set(bare, self.unicode)
        if cs is None:
            raise self.fail(
                POSIX_UNKNOWN, self.src.find(":]", self.pos + 2) + 2
            )
        self.pos = self.src.find(":]", self.pos + 2) + 2
        return cs.negate() if negated else cs

    def class_char(self) -> int | CharSet:
        """One character (or class escape) inside a class."""
        ch = self.src[self.pos]
        if ch != "\\":
            self.pos += 1
            return ord(ch)
        if self.pos + 1 >= len(self.src):
            raise self.fail(TRAILING_BACKSLASH, len(self.src))
        letter = self.src[self.pos + 1]
        self.pos += 2
        if letter == "N":
            raise self.fail(N_IN_CLASS)
        if letter in "BRXGKAzZgk":
            raise self.fail(ESCAPE_IN_CLASS)
        cs = self.class_escape(letter)
        if cs is not None:
            return cs
        return self.char_escape(letter, True)


def first_outside(text: str, allowed: str) -> int:
    """The index of the first character of ``text`` not in ``allowed``.

    Args:
        text (str): the digits as typed.
        allowed (str): the digits the escape takes.
    """
    return next(
        (i for i, ch in enumerate(text) if ch not in allowed), len(text)
    )


def word_edge(start: bool, unicode: bool) -> str:
    """Spencer's ``[[:<:]]`` / ``[[:>:]]``: a word's start or end.

    Args:
        start (bool): the start rather than the end.
        unicode (bool): Unicode word characters rather than ASCII.
    """
    w = word_source(unicode)
    return f"(?<!{w})(?={w})" if start else f"(?<={w})(?!{w})"


def boundary(word: bool, unicode: bool) -> str:
    """``\\b`` (``word``) or ``\\B`` over the dialect's word class.

    Args:
        word (bool): a boundary rather than a non-boundary.
        unicode (bool): Unicode word characters rather than ASCII.
    """
    w = word_source(unicode)
    if word:
        return f"(?:(?<={w})(?!{w})|(?<!{w})(?={w}))"
    return f"(?:(?<={w})(?={w})|(?<!{w})(?!{w}))"


@cache
def word_source(unicode: bool) -> str:
    """The host class for ``\\w``, built once per mode.

    Args:
        unicode (bool): UCP rather than ASCII.
    """
    return host_class(pcre_word() if unicode else ASCII_WORD)


def posix_set(name: str, unicode: bool) -> CharSet | None:
    """One POSIX class, under UCP as PCRE2 maps it to properties.

    Args:
        name (str): the class name.
        unicode (bool): UCP rather than ASCII.
    """
    if name not in ASCII_CLASSES:
        return None
    if not unicode or name in ("ascii", "xdigit"):
        return ASCII_CLASSES[name]
    if name in UCP_POSIX:
        out = CharSet()
        for part in UCP_POSIX[name]:
            out = out.union(category(part))
        return out
    if name == "space":
        return PCRE_HSPACE.union(PCRE_VSPACE)
    if name == "blank":
        return PCRE_HSPACE
    if name == "word":
        return pcre_word()
    graph = CharSet()
    for part in ("L", "M", "N", "P", "S", "Cf"):
        graph = graph.union(category(part))
    graph = graph.minus(GRAPH_EXCLUDED)
    if name == "graph":
        return graph
    if name == "print":
        return graph.union(category("Zs")).minus(GRAPH_EXCLUDED)
    return category("P").union(category("S").intersect(ASCII_CLASSES["ascii"]))


def pcre_property(name: str) -> CharSet | None:
    """A ``\\p`` name as PCRE2 reads it, or None.

    Args:
        name (str): the name between the braces (or the one letter).
    """
    special = {
        "L&": category("LC"),
        "Xan": category("L").union(category("N")),
        "Xsp": PCRE_HSPACE.union(PCRE_VSPACE),
        "Xps": PCRE_HSPACE.union(PCRE_VSPACE),
        "Xwd": pcre_word(),
    }
    if name in special:
        return special[name]
    return unicode_property(name)


@lru_cache(maxsize=256)
def count_groups(pattern: str) -> int:
    """How many capturing groups a PCRE2 pattern has, for ``\\10``.

    Args:
        pattern (str): the pattern.
    """
    count = 0
    i = 0
    while i < len(pattern):
        ch = pattern[i]
        if ch == "\\":
            if pattern.startswith("\\Q", i):
                end = pattern.find("\\E", i + 2)
                i = len(pattern) if end < 0 else end + 2
                continue
            i += 2
            continue
        if ch == "[":
            i += 1
            if pattern[i : i + 1] == "^":
                i += 1
            if pattern[i : i + 1] == "]":
                i += 1
            while i < len(pattern) and pattern[i] != "]":
                i += 2 if pattern[i] == "\\" else 1
            i += 1
            continue
        if ch == "(":
            rest = pattern[i + 1 : i + 4]
            if not rest.startswith(("?", "*")) or (
                rest.startswith(("?<", "?'", "?P<"))
                and not rest.startswith(("?<=", "?<!"))
            ):
                count += 1
        i += 1
    return count


@lru_cache(maxsize=256)
def named_groups(pattern: str) -> frozenset[str]:
    """The group names a PCRE2 pattern defines anywhere.

    Args:
        pattern (str): the pattern.
    """
    return frozenset(a or b for a, b in GROUP_NAMES.findall(pattern))


def translate_pcre(
    pattern: str,
    unicode: bool = False,
    ignore_case: bool = False,
    multi_line: bool = False,
) -> HostRegex:
    """Translate a PCRE2 pattern into this host's regex dialect.

    Args:
        pattern (str): the pattern as PCRE2 would compile it (after any
            -w/-x wrapping the caller applies).
        unicode (bool): UTF and UCP (ripgrep's default), else grep's
            ASCII classes.
        ignore_case (bool): -i (PCRE2_CASELESS).
        multi_line (bool): PCRE2_MULTILINE.

    Returns:
        HostRegex: the host source and whether the host folds case.

    Raises:
        PcreError: PCRE2 refuses the pattern, or it needs something no
            host engine can express.
    """
    if ignore_case and not INLINE_CASE.search(pattern):
        translated = PcreTranslator(
            pattern, unicode, Flags(m=multi_line)
        ).translate()
        return HostRegex(translated.source, True)
    flags = Flags(i=ignore_case, m=multi_line)
    return PcreTranslator(pattern, unicode, flags).translate()


@lru_cache(maxsize=256)
def keep_names(pattern: re.Pattern[str]) -> tuple[str, ...]:
    """The ``\\K`` marker groups of a compiled pattern.

    Args:
        pattern (re.Pattern[str]): the compiled pattern.
    """
    return tuple(
        name for name in pattern.groupindex if name.startswith(KEEP_PREFIX)
    )


def match_start(m: re.Match[str]) -> int:
    """Where a match starts as PCRE2 reports it: past its last ``\\K``.

    Args:
        m (re.Match[str]): the host match.
    """
    names = keep_names(m.re)
    if not names:
        return m.start()
    starts = [m.start(name) for name in names if m.start(name) >= 0]
    return max(starts, default=m.start())


def match_text(m: re.Match[str]) -> str:
    """The text a match reports: from ``match_start`` to its end.

    Args:
        m (re.Match[str]): the host match.
    """
    start = match_start(m)
    return m.group() if start == m.start() else m.string[start : m.end()]


@lru_cache(maxsize=256)
def user_groups(pattern: re.Pattern[str]) -> tuple[int, ...]:
    """The host group number of each group the user's pattern numbers.

    Synthetic groups (``\\K`` markers, emulated atomic groups) take host
    numbers of their own, so ``$1`` in a replacement is the first host
    group that is not one of them.

    Args:
        pattern (re.Pattern[str]): the compiled pattern.
    """
    synthetic = {
        number
        for name, number in pattern.groupindex.items()
        if name.startswith(SYNTHETIC_PREFIX)
    }
    return tuple(n for n in range(1, pattern.groups + 1) if n not in synthetic)
