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

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.bre import BreError, compile_bre
from mirage.commands.config import Context, command
from mirage.commands.quote import quote_word
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import byte_view, from_byte_view, utf8_locale
from mirage.types import PathSpec

# GNU expr's operand grammar, which is narrower than either language's
# own integer parser: no sign but a leading `-`, no surrounding space,
# no digit separator, no `0x`/`1e3` form. Leading zeros are decimal, so
# `05` is 5. Spelled `[0-9]` rather than `\d` because python's `\d`
# also matches non-ASCII digits, where the TypeScript twin
# (`INT_OPERAND_RE`, expr.ts) is ASCII-only.
#
# Carried unanchored and read with `fullmatch`, never `^...$` with
# `match`: python's `$` also matches immediately before a trailing
# newline, so the anchored form accepted `12\n` as 12 while GNU's
# scanner stops at the first non-digit and refuses it. JavaScript's `$`
# is already end-of-input, which is why the twin keeps `^-?\d+$`.
INT_OPERAND_RE = re.compile(r"-?[0-9]+")

CMP_OPS = ("=", "==", "!=", "<", "<=", ">", ">=")
ADD_OPS = ("+", "-")
MUL_OPS = ("*", "/", "%")

NON_INTEGER = "expr: non-integer argument"
DIVISION_BY_ZERO = "expr: division by zero"

# GNU's only two-line diagnostic, and the only one it reaches for when
# the line leaves zero expression words -- `expr` and `expr --`, since
# `--` is consumed as the options terminator. Every other refusal is one
# `syntax error: <detail>` line.
MISSING_OPERAND = (
    "expr: missing operand\nTry 'expr --help' for more information.\n"
)

# GNU declares no nesting limit and segfaults on a C-stack overflow at
# somewhere past 10000 parentheses, with nothing on stderr, so there is
# no message to copy. This limit is ours: it keeps the recursive descent
# well inside CPython's default recursion limit (eight frames per level)
# and is far past any expression written by hand.
MAX_NESTING = 64
NESTING_TOO_DEEP = f"expr: expression nesting too deep (limit {MAX_NESTING})"


class ExprError(Exception):
    """An operand or operation GNU expr refuses, worded as GNU words it."""


# How many decimal digits to convert in one go. CPython caps a base-10
# `int(str)` or `str(int)` at `sys.get_int_max_str_digits()`, 4300 by
# default, so both conversions below work in chunks under that cap and
# combine them with arithmetic, which is not capped. 4000 leaves room
# under the default without making the chunk count interesting.
DIGIT_CHUNK = 4000

# Hoisted because `10**4000` costs ~50us to build and both conversions
# would otherwise rebuild it on every call -- which made rendering a
# two-digit sum 250x slower than `str()` on it.
DIGIT_CHUNK_STEP = 10**DIGIT_CHUNK


def int_of_digits(text: str) -> int:
    """A decimal digit string as an int, at any length.

    GNU expr is arbitrary precision and so is python's `int`, but the
    *conversion* between an int and its decimal spelling is not:
    CPython raises `ValueError` past `sys.get_int_max_str_digits()`.
    Raising that limit is `sys.set_int_max_str_digits()`, which is a
    process-global the embedding program owns, so this converts in
    chunks small enough to stay under it and accumulates with
    multiplication and addition, which have no limit. Exact at every
    length, and local to this module.

    Args:
        text (str): the digits, optionally led by a single `-`. The
            caller has already matched INT_OPERAND_RE, so there is
            nothing else to validate here.

    Returns:
        int: the value.
    """
    # Every operand anyone writes takes this path; the chunking below is
    # for the ones CPython would refuse outright.
    if len(text) <= DIGIT_CHUNK:
        return int(text)
    negative = text.startswith("-")
    digits = text[1:] if negative else text
    value = 0
    for start in range(0, len(digits), DIGIT_CHUNK):
        chunk = digits[start : start + DIGIT_CHUNK]
        value = value * 10 ** len(chunk) + int(chunk)
    return -value if negative else value


def digits_of_int(value: int) -> str:
    """An int as its decimal spelling, at any length.

    The mirror of `int_of_digits`, and it exists for the same reason:
    `str()` on a wide enough result raises rather than answering, and
    the result of `expr 2200-nines '*' 2200-nines` is wide enough.
    `divmod` by a power of ten peels off a chunk at a time; every chunk
    but the most significant is zero-padded, because a leading zero
    inside the number is a digit and dropping it would silently shorten
    the answer.

    Args:
        value (int): the value to render.

    Returns:
        str: the decimal spelling, with a leading `-` when negative.
    """
    negative = value < 0
    rest = -value if negative else value
    # Anything under the chunk width is at most 4000 digits, so `str`
    # cannot raise on it; this is the path every real result takes.
    if rest < DIGIT_CHUNK_STEP:
        return ("-" if negative else "") + str(rest)
    chunks: list[str] = []
    while rest >= DIGIT_CHUNK_STEP:
        rest, chunk = divmod(rest, DIGIT_CHUNK_STEP)
        chunks.append(f"{chunk:0{DIGIT_CHUNK}d}")
    chunks.append(str(rest))
    chunks.reverse()
    return ("-" if negative else "") + "".join(chunks)


def missing_argument_after(word: str, utf8: bool = False) -> str:
    """GNU's wording for an operator with nothing to its right.

    Args:
        word (str): the last word the parser consumed, which is what GNU
            names here rather than the operator that needed an operand --
            `expr substr abc 1` reports `1`, not `substr`. It outranks an
            unclosed parenthesis: `expr '(' 1 +` reports this, not
            `expecting ')'`.
        utf8 (bool): the word is text, under a UTF-8 locale.

    Returns:
        str: the full diagnostic line, without its newline.
    """
    quoted = quote_word(word, utf8)
    return f"expr: syntax error: missing argument after '{quoted}'"


def unexpected_argument(word: str, utf8: bool = False) -> str:
    """GNU's wording for a leftover word the grammar had no slot for.

    Args:
        word (str): the offending argument.
        utf8 (bool): the word is text, under a UTF-8 locale.

    Returns:
        str: the full diagnostic line, without its newline.
    """
    quoted = quote_word(word, utf8)
    return f"expr: syntax error: unexpected argument '{quoted}'"


def expecting_close(current: str | None, prev: str, utf8: bool = False) -> str:
    """GNU's wording for a parenthesis that was never closed.

    GNU has two clauses here and picks between them on one fact: whether
    the line ran out or a word is standing where the `)` belonged. It
    names the last word consumed in the first case and the offending
    word in the second, so `expr '(' 1` reports `after '1'` while
    `expr '(' 1 1` reports `instead of '1'` -- the same text for
    different reasons, and different text for what looks like the same
    error.

    Args:
        current (str | None): the word sitting where the `)` was
            expected, or None when the line ran out.
        prev (str): the last word the parser consumed.
        utf8 (bool): the words are text, under a UTF-8 locale.

    Returns:
        str: the full diagnostic line, without its newline.
    """
    if current is None:
        quoted = quote_word(prev, utf8)
        return f"expr: syntax error: expecting ')' after '{quoted}'"
    quoted = quote_word(current, utf8)
    return f"expr: syntax error: expecting ')' instead of '{quoted}'"


# The one detail clause with no `argument` noun in it, for a `)` where a
# primary was expected. A `)` left over at the *end* of a complete
# expression is reported by `unexpected_argument` instead.
UNEXPECTED_CLOSE = "expr: syntax error: unexpected ')'"


def parse_int_operand(text: str) -> int:
    """One expr operand read as GNU reads it.

    Args:
        text (str): the operand exactly as it arrived on the line.

    Returns:
        int: the parsed value. GNU expr is arbitrary precision, so no
            bound is applied here; the TypeScript twin reads the same
            grammar into a `bigint` for the same reason. The read goes
            through `int_of_digits` rather than `int` so CPython's
            base-10 conversion cap does not bound it either.

    Raises:
        ExprError: the operand is not an integer in GNU's grammar.
    """
    if INT_OPERAND_RE.fullmatch(text) is None:
        raise ExprError(NON_INTEGER)
    return int_of_digits(text)


def int_operand_or_none(text: str) -> int | None:
    """The same read, for a comparison that falls back to strings.

    Args:
        text (str): the operand exactly as it arrived on the line.

    Returns:
        int | None: the parsed value, or None when the operand is not an
            integer in GNU's grammar.
    """
    if INT_OPERAND_RE.fullmatch(text) is None:
        return None
    return int_of_digits(text)


def is_null(value: str) -> bool:
    """Whether GNU expr counts a value as false.

    False is not "empty or the character zero": the empty string is
    false, and so is any run of zeros with at most one leading
    minus, which is why `expr 00 '&' 1` is false and `expr - '&' 1` is
    not.

    Args:
        value (str): the value to test.

    Returns:
        bool: True when the value is false, which is also the value that
            makes expr exit 1.
    """
    if value == "":
        return True
    digits = value[1:] if value[0] == "-" else value
    return digits != "" and all(ch == "0" for ch in digits)


def trunc_div(a: int, b: int) -> int:
    """Integer division truncated toward zero, as C and GNU expr do it.

    Python's `//` floors, so `-10 // 3` is -4 where GNU expr says -3.
    Implemented here rather than borrowed from `shell/arith.py`: those
    helpers are private to the shell's `$(( ))` evaluator, importing
    them would cross a package boundary, and they raise the shell's
    `division by 0` wording rather than expr's.

    Args:
        a (int): the dividend.
        b (int): the divisor.

    Returns:
        int: the quotient, rounded toward zero.

    Raises:
        ExprError: the divisor is zero.
    """
    if b == 0:
        raise ExprError(DIVISION_BY_ZERO)
    quotient = abs(a) // abs(b)
    return -quotient if (a < 0) != (b < 0) else quotient


def trunc_mod(a: int, b: int) -> int:
    """The remainder that takes the dividend's sign, as GNU expr does.

    `-10 % 3` is -1 and `10 % -3` is 1, where Python's `%` answers 2 and
    -2. GNU reports a zero divisor here with the same `division by zero`
    message it uses for `/`, not a modulo variant.

    Args:
        a (int): the dividend.
        b (int): the divisor.

    Returns:
        int: the remainder, signed like `a`.

    Raises:
        ExprError: the divisor is zero.
    """
    if b == 0:
        raise ExprError(DIVISION_BY_ZERO)
    remainder = abs(a) % abs(b)
    return -remainder if a < 0 else remainder


def order_of(left: str, right: str) -> int:
    """Compare two operands the way GNU's `=` family compares them.

    The comparison is numeric only when **both** sides are integers in
    GNU's grammar; one bad side makes it a byte-order string compare, so
    `expr 10 '>' 9a` is false and `expr '+1' '=' 1` is false.

    Args:
        left (str): the left operand.
        right (str): the right operand.

    Returns:
        int: -1, 0 or 1.
    """
    a = int_operand_or_none(left)
    b = int_operand_or_none(right)
    if a is not None and b is not None:
        return (a > b) - (a < b)
    return (left > right) - (left < right)


def compare(left: str, op: str, right: str) -> str:
    """One comparison, answered as GNU's `1` or `0`.

    Args:
        left (str): the left operand.
        op (str): one of `=`, `==`, `!=`, `<`, `<=`, `>`, `>=`. `==` is
            an undocumented synonym for `=`.
        right (str): the right operand.

    Returns:
        str: `1` when the comparison holds, else `0`.
    """
    order = order_of(left, right)
    if op in ("=", "=="):
        held = order == 0
    elif op == "!=":
        held = order != 0
    elif op == "<":
        held = order < 0
    elif op == "<=":
        held = order <= 0
    elif op == ">":
        held = order > 0
    else:
        held = order >= 0
    return "1" if held else "0"


def colon_match(subject: str, pattern: str, utf8: bool = False) -> str:
    """The `:` operator, which `match` is the prefix spelling of.

    POSIX: the pattern is a BRE anchored at the start of the subject. A
    pattern with a group answers with what group 1 matched -- the
    empty string when the match failed or the group took no part --
    and one without answers with the length of the match, `0` when
    there is none. Whether it has a group is the pattern's business
    alone, so a failed `expr abc : '\\(x\\)'` is empty, not `0`.

    Both strings are byte views, so `.` matches one byte and the length
    counts bytes: GNU reads `expr <e-acute> : '.'` as 1 and
    `expr <e-acute> : '\\(.\\)'` as the single byte `c3`. Under a UTF-8
    locale (`utf8`) both are text and the same two answer the whole
    character.

    Args:
        subject (str): the string to match, as a byte view.
        pattern (str): the BRE, as a byte view.
        utf8 (bool): both are text, under a UTF-8 locale.

    Returns:
        str: group 1's text, or the match length.

    Raises:
        ExprError: glibc's wording for a pattern it refuses, under
            expr's own prefix.
    """
    try:
        compiled, groups = compile_bre(pattern, utf8)
    except BreError as exc:
        raise ExprError(f"expr: {exc}") from exc
    found = compiled.match(subject)
    if groups:
        return "" if found is None else found.group(1) or ""
    return "0" if found is None else str(found.end())


def do_index(text: str, chars: str) -> str:
    """The `index` operator, which is `strcspn` over a character set.

    It is not a substring search: `expr index abcde ec` is 3, because
    `c` sits earlier in the subject than `e` does. Both arguments are
    byte views, so the set is a set of bytes and the position counts
    bytes: `expr index <a-umlaut> <e-acute>` is 1, because both
    characters begin with the byte `c3`.

    Args:
        text (str): the subject, as a byte view.
        chars (str): the set of bytes to look for, as a byte view.

    Returns:
        str: the 1-based position of the first subject byte that is in
            the set, or `0` when there is none.
    """
    wanted = set(chars)
    for offset, ch in enumerate(text):
        if ch in wanted:
            return str(offset + 1)
    return "0"


def do_substr(text: str, pos_arg: str, len_arg: str) -> str:
    """The `substr` operator, 1-based and forgiving.

    A position that is zero, negative, past the end or not a number at
    all is not an error: GNU answers with the empty string, which makes
    expr exit 1. A negative or zero length answers the same way, and an
    over-long one clamps.

    The subject is a byte view, so both the position and the length
    count bytes and a slice may land mid-character. GNU does exactly
    that and prints the half it selected, so this does too.

    Args:
        text (str): the subject, as a byte view.
        pos_arg (str): the 1-based start position, as written.
        len_arg (str): the length, as written.

    Returns:
        str: the selected bytes, or the empty string.
    """
    start = int_operand_or_none(pos_arg)
    count = int_operand_or_none(len_arg)
    if start is None or count is None:
        return ""
    if start < 1 or count < 0 or start > len(text):
        return ""
    return text[start - 1 : start - 1 + count]


# How many operands each prefix keyword reads: GNU's `match`, `substr`,
# `index` and `length`.
KEYWORD_ARITY = {"match": 2, "substr": 3, "index": 2, "length": 1}


class ExprReader:
    """An expr line read and evaluated in one left-to-right pass.

    The grammar is POSIX's, loosest first: `|`, `&`, the six
    comparisons (and GNU's `==`), `+ -`, `* / %`, then `:`, every level
    left-associative. Under `:` sit GNU's operands: a prefix keyword
    (`match`, `substr`, `index`, `length`) with its operands, `+ WORD`
    quoting one word, `( EXPR )`, or any other single word, operator
    words included (`expr '*'` prints `*`). There is no unary operator:
    `-5` is a word and so is `-`.

    ``live`` is false inside an operand `|` or `&` has already decided
    (`expr 1 '|' a / 0` prints 1): the operand is still read, so a
    syntax error in it still counts, but nothing in it is computed and
    so nothing in it can refuse a value -- not a non-integer, not a zero
    divisor, not a bad pattern.

    Every word and value is a byte view (see `_expr_eval`), or text
    under a UTF-8 locale (``utf8``).

    Args:
        words (list[str]): the expression words.
        utf8 (bool): the words are text, under a UTF-8 locale.
    """

    def __init__(self, words: list[str], utf8: bool = False) -> None:
        self.words = words
        self.utf8 = utf8
        self.next = 0
        self.depth = 0

    def done(self) -> bool:
        return self.next >= len(self.words)

    def ahead(self) -> str | None:
        return None if self.done() else self.words[self.next]

    def last_read(self) -> str:
        return self.words[self.next - 1]

    def read_word(self) -> str:
        """The next word, which has to be there.

        Raises:
            ExprError: the line ran out; GNU names the word before.
        """
        if self.done():
            raise ExprError(
                missing_argument_after(self.last_read(), self.utf8)
            )
        self.next += 1
        return self.words[self.next - 1]

    def take_if(self, wanted: tuple[str, ...]) -> str | None:
        word = self.ahead()
        if word is None or word not in wanted:
            return None
        self.next += 1
        return word

    def either(self, live: bool) -> str:
        """`A | B`: A unless it is null or 0, else B unless it is, else 0."""
        left = self.both(live)
        while self.take_if(("|",)):
            right = self.both(live and is_null(left))
            if live and is_null(left):
                left = right if not is_null(right) else "0"
        return left

    def both(self, live: bool) -> str:
        """`A & B`: A when neither is null or 0, else 0."""
        left = self.relation(live)
        while self.take_if(("&",)):
            right = self.relation(live and not is_null(left))
            if live:
                left = "0" if is_null(left) or is_null(right) else left
        return left

    def relation(self, live: bool) -> str:
        left = self.sum(live)
        while (op := self.take_if(CMP_OPS)) is not None:
            right = self.sum(live)
            if live:
                left = compare(left, op, right)
        return left

    def sum(self, live: bool) -> str:
        left = self.product(live)
        while (op := self.take_if(ADD_OPS)) is not None:
            right = self.product(live)
            if live:
                a, b = parse_int_operand(left), parse_int_operand(right)
                left = digits_of_int(a + b if op == "+" else a - b)
        return left

    def product(self, live: bool) -> str:
        left = self.matching(live)
        while (op := self.take_if(MUL_OPS)) is not None:
            right = self.matching(live)
            if live:
                a, b = parse_int_operand(left), parse_int_operand(right)
                if op == "*":
                    left = digits_of_int(a * b)
                elif op == "/":
                    left = digits_of_int(trunc_div(a, b))
                else:
                    left = digits_of_int(trunc_mod(a, b))
        return left

    def matching(self, live: bool) -> str:
        left = self.operand(live)
        while self.take_if((":",)):
            right = self.operand(live)
            if live:
                left = colon_match(left, right, self.utf8)
        return left

    def operand(self, live: bool) -> str:
        """One operand under `:`, prefix keywords applied.

        A keyword reads its own operands at this same level, so
        `length length abc` is 1 and `substr + abc 1 1` is `a`. Those
        chains are kept on a list here rather than on the call stack:
        GNU reads one of any length, and only parentheses count toward
        the nesting limit.
        """
        waiting: list[tuple[str, list[str]]] = []
        while True:
            word = self.read_word()
            if word in KEYWORD_ARITY:
                waiting.append((word, []))
                continue
            value = self.simple(word, live)
            while waiting:
                keyword, given = waiting[-1]
                given.append(value)
                if len(given) < KEYWORD_ARITY[keyword]:
                    break
                waiting.pop()
                value = self.keyword(keyword, given) if live else ""
            if not waiting:
                return value

    def keyword(self, keyword: str, given: list[str]) -> str:
        if keyword == "length":
            return str(len(given[0]))
        if keyword == "index":
            return do_index(given[0], given[1])
        if keyword == "substr":
            return do_substr(given[0], given[1], given[2])
        return colon_match(given[0], given[1], self.utf8)

    def simple(self, word: str, live: bool) -> str:
        """`+ WORD`, `( EXPR )` or a word standing for itself.

        Args:
            word (str): the word already read.
            live (bool): whether to compute.
        """
        if word == "+":
            return self.read_word()
        if word == ")":
            raise ExprError(UNEXPECTED_CLOSE)
        if word != "(":
            return word
        if self.depth >= MAX_NESTING:
            raise ExprError(NESTING_TOO_DEEP)
        self.depth += 1
        value = self.either(live)
        self.depth -= 1
        if self.take_if((")",)) is None:
            raise ExprError(
                expecting_close(self.ahead(), self.last_read(), self.utf8)
            )
        return value


def _expr_eval(args: list[str], utf8: bool = False) -> tuple[str, int]:
    """Evaluate a whole expr line.

    Args:
        args (list[str]): the expression words as byte views, `--`
            already consumed by the option parser.
        utf8 (bool): the words are text, under a UTF-8 locale.

    Returns:
        tuple[str, int]: the value to print, as a byte view, and the
            exit code. GNU exits 1 when the value is false even on full
            success, so exit 1 means "the answer was zero or empty" and
            exit 2 is the only error status.

    Raises:
        ExprError: anything GNU refuses.
    """
    reader = ExprReader(args, utf8)
    value = reader.either(True)
    if not reader.done():
        raise ExprError(unexpected_argument(reader.words[reader.next], utf8))
    return value, 1 if is_null(value) else 0


@command("expr", vfs=None, spec=SPECS["expr"])
async def expr(
    accessor: Accessor,
    paths: list[PathSpec] | None,
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        return None, IOResult(
            exit_code=2, stderr=from_byte_view(MISSING_OPERAND)
        )
    utf8 = utf8_locale(ctx.env)
    try:
        result, exit_code = _expr_eval(
            [byte_view(t, utf8) for t in texts], utf8
        )
    except ExprError as exc:
        # GNU writes the refusal to stderr, nothing to stdout, and exits
        # 2; exit 1 is reserved for a zero-valued success. The
        # diagnostic quotes a byte view of the offending word, so it
        # leaves through the same entry point the value does.
        return None, IOResult(
            exit_code=2, stderr=from_byte_view(f"{exc}\n", utf8)
        )
    return from_byte_view(result + "\n", utf8), IOResult(exit_code=exit_code)
