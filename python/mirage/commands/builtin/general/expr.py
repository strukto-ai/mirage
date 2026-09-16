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
from mirage.commands.builtin.generic_bind.provision import pure_provision
from mirage.commands.builtin.utils.bre import BreError, compile_bre
from mirage.commands.config import CommandOpts
from mirage.commands.quote import quote_word
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
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
MUL_OPS = ("*", "/", "%")

NON_INTEGER = "expr: non-integer argument"
DIVISION_BY_ZERO = "expr: division by zero"

# GNU's only two-line diagnostic, and the only one it reaches for when
# the line leaves zero expression words -- `expr` and `expr --`, since
# `--` is consumed as the options terminator. Every other refusal is one
# `syntax error: <detail>` line.
MISSING_OPERAND = ("expr: missing operand\n"
                   "Try 'expr --help' for more information.\n")

# GNU declares no nesting limit and segfaults on a C-stack overflow at
# somewhere past 10000 parentheses, with nothing on stderr, so there is
# no message to copy. This limit is ours: it keeps the recursive descent
# well inside CPython's default recursion limit (eight frames per level)
# and is far past any expression written by hand.
MAX_NESTING = 64
NESTING_TOO_DEEP = ("expr: expression nesting too deep "
                    f"(limit {MAX_NESTING})")


class ExprError(Exception):
    """An operand or operation GNU expr refuses, worded as GNU words it."""


def to_byte_view(text: str) -> str:
    """One argv word as GNU sees it: one character per byte.

    Every expr string operator counts bytes, not characters, because
    GNU runs in the C locale: `expr length ee` with two two-byte `e`
    acutes is 4, `substr` will split one character in half and print
    the half (`expr substr <e-acute><e-acute> 2 2` is the bytes
    `a9 c3`), `index` searches a set of bytes so a byte shared with
    another character matches, and the BRE's `.` matches one byte. All
    of that follows from one representation change rather than four
    special cases, so the whole parser runs on a string whose every
    character is one byte and the conversion happens only at the
    command boundary.

    Args:
        text (str): the word as the shell handed it over, a raw byte
            riding as its surrogate escape.

    Returns:
        str: the same bytes, one per character, every code point below
            256.
    """
    return text.encode("utf-8", "surrogateescape").decode("latin-1")


def from_byte_view(view: str) -> bytes:
    """The bytes a byte-view string stands for.

    Args:
        view (str): a value or a diagnostic built from byte-view words
            and this module's ASCII wording, so every code point is
            below 256.

    Returns:
        bytes: the bytes to write. GNU writes the raw bytes of the
            operand it was handed, so a `substr` that split a character
            prints the invalid half rather than a replacement
            character.
    """
    return view.encode("latin-1")


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
        chunk = digits[start:start + DIGIT_CHUNK]
        value = value * 10**len(chunk) + int(chunk)
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


def missing_argument_after(word: str) -> str:
    """GNU's wording for an operator with nothing to its right.

    Args:
        word (str): the last word the parser consumed, which is what GNU
            names here rather than the operator that needed an operand --
            `expr substr abc 1` reports `1`, not `substr`. It outranks an
            unclosed parenthesis: `expr '(' 1 +` reports this, not
            `expecting ')'`.

    Returns:
        str: the full diagnostic line, without its newline.
    """
    return f"expr: syntax error: missing argument after '{quote_word(word)}'"


def unexpected_argument(word: str) -> str:
    """GNU's wording for a leftover word the grammar had no slot for.

    Args:
        word (str): the offending argument.

    Returns:
        str: the full diagnostic line, without its newline.
    """
    return f"expr: syntax error: unexpected argument '{quote_word(word)}'"


def expecting_close(current: str | None, prev: str) -> str:
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

    Returns:
        str: the full diagnostic line, without its newline.
    """
    if current is None:
        return ("expr: syntax error: expecting ')' after "
                f"'{quote_word(prev)}'")
    return ("expr: syntax error: expecting ')' instead of "
            f"'{quote_word(current)}'")


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

    GNU's `null()` is not "empty or the character zero": the empty
    string is false, and so is any run of zeros with at most one leading
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


def docolon(subject: str, pattern: str) -> str:
    """The `:` operator, which `match` is the prefix spelling of.

    The pattern is a POSIX BRE anchored at the start of the subject. A
    pattern with a group answers with group 1's text -- the empty string
    when the group did not participate -- and one without answers with
    the match length, or `0` when nothing matched. Which of the two it is
    depends on the pattern alone, so the group count has to come from the
    translator rather than from a match object that may not exist.

    Args:
        subject (str): the string being matched.
        pattern (str): the BRE, in GNU's dialect.

    Both the subject and the pattern are byte views, so `.` matches one
    byte and the length this answers with is a byte count: GNU reads
    `expr <e-acute> : '.'` as 1 and `expr <e-acute> : '\\(.\\)'` as the
    single byte `c3`.

    Returns:
        str: group 1's text, the match length, or a null value.

    Raises:
        ExprError: the pattern is one glibc's regex compiler refuses.
    """
    try:
        regex, groups = compile_bre(pattern)
    except BreError as exc:
        raise ExprError(f"expr: {exc}") from exc
    matched = regex.match(subject)
    if matched is None:
        return "" if groups else "0"
    if groups:
        return matched.group(1) or ""
    return str(len(matched.group(0)))


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
    return text[start - 1:start - 1 + count]


class ExprParser:
    """GNU expr's grammar as a recursive descent over argv words.

    Each level binds tighter than the one above it and every level is
    left-associative: `|`, then `&`, then the comparisons, then `+ -`,
    then `* / %`, then `:`, then the keyword operators and `+ TOKEN`,
    then primaries. There is no unary operator anywhere -- `-5` is an
    integer literal, `+` is the string-quoting operator, and `^`, `!`
    and `<>` are not operators at all. The structure is mirrored level
    for level in `expr.ts`.

    `evaluate` threads GNU's short-circuiting through: `|` and `&` parse
    their right operand with it false when the left already decided the
    answer, and every level that can refuse a value checks it first, so
    `expr 1 '|' 1 '/' 0` is 1 rather than a division by zero.

    Every word in `args`, every value it produces and every word it
    quotes in a diagnostic is a byte view (`to_byte_view`), which is
    what makes `length`, `index`, `substr` and `:` count bytes as GNU
    does and makes a string comparison the `strcmp` byte order GNU
    uses. The conversion is the command's, not the parser's.
    """

    def __init__(self, args: list[str]) -> None:
        self.args = args
        self.pos = 0
        self.depth = 0

    def at_end(self) -> bool:
        """Whether every word has been consumed.

        Returns:
            bool: True when no words are left.
        """
        return self.pos >= len(self.args)

    def peek(self) -> str | None:
        """The next word without consuming it.

        Returns:
            str | None: the word, or None at the end of the line.
        """
        return None if self.at_end() else self.args[self.pos]

    def nextarg(self, word: str) -> bool:
        """Consume the next word if it is exactly `word`.

        Args:
            word (str): the operator or keyword to look for.

        Returns:
            bool: True when it was there and has been consumed.
        """
        if self.peek() == word:
            self.pos += 1
            return True
        return False

    def take(self) -> str:
        """Consume the next word unconditionally.

        Returns:
            str: the word.
        """
        word = self.args[self.pos]
        self.pos += 1
        return word

    def prev(self) -> str:
        """The last word consumed, which GNU names in two diagnostics.

        Returns:
            str: the word, or the empty string before anything was read.
        """
        return self.args[self.pos - 1] if self.pos > 0 else ""

    def require_more_args(self) -> None:
        """Refuse a line that ended where an operand was needed.

        Raises:
            ExprError: the line is exhausted.
        """
        if self.at_end():
            raise ExprError(missing_argument_after(self.prev()))

    def eval_or(self, evaluate: bool) -> str:
        """Level 1: `|`, which short-circuits on a truthy left operand.

        Args:
            evaluate (bool): False inside a branch already decided.

        Returns:
            str: the left operand when it is truthy, else the right one,
                normalised to `0` when both are falsy.
        """
        left = self.eval_and(evaluate)
        while self.nextarg("|"):
            right = self.eval_and(evaluate and is_null(left))
            if is_null(left):
                left = "0" if is_null(right) else right
        return left

    def eval_and(self, evaluate: bool) -> str:
        """Level 2: `&`, which short-circuits on a falsy left operand.

        Args:
            evaluate (bool): False inside a branch already decided.

        Returns:
            str: the left operand when both are truthy, else `0`.
        """
        left = self.eval_compare(evaluate)
        while self.nextarg("&"):
            right = self.eval_compare(evaluate and not is_null(left))
            if is_null(left) or is_null(right):
                left = "0"
        return left

    def eval_compare(self, evaluate: bool) -> str:
        """Level 3: the six comparisons, plus `==` as a synonym for `=`.

        Args:
            evaluate (bool): False inside a branch already decided.

        Returns:
            str: the value of the chain.
        """
        left = self.eval_additive(evaluate)
        while True:
            op = self.peek()
            if op is None or op not in CMP_OPS:
                return left
            self.pos += 1
            right = self.eval_additive(evaluate)
            if evaluate:
                left = compare(left, op, right)

    def eval_additive(self, evaluate: bool) -> str:
        """Level 4: `+` and `-` as binary arithmetic.

        A `+` in an *operand* position is the quoting operator instead,
        which is why `expr 1 + + 2` is 3: this level reads the first `+`
        and `eval_keyword` reads the second.

        Args:
            evaluate (bool): False inside a branch already decided.

        Returns:
            str: the value of the chain.

        Raises:
            ExprError: an operand is not an integer.
        """
        left = self.eval_multiplicative(evaluate)
        while True:
            if self.nextarg("+"):
                op = "+"
            elif self.nextarg("-"):
                op = "-"
            else:
                return left
            right = self.eval_multiplicative(evaluate)
            if evaluate:
                a = parse_int_operand(left)
                b = parse_int_operand(right)
                left = digits_of_int(a + b if op == "+" else a - b)

    def eval_multiplicative(self, evaluate: bool) -> str:
        """Level 5: `*`, `/` and `%`, which share one level.

        Args:
            evaluate (bool): False inside a branch already decided.

        Returns:
            str: the value of the chain.

        Raises:
            ExprError: an operand is not an integer, or a divisor is
                zero.
        """
        left = self.eval_colon(evaluate)
        while True:
            op = self.peek()
            if op is None or op not in MUL_OPS:
                return left
            self.pos += 1
            right = self.eval_colon(evaluate)
            if evaluate:
                a = parse_int_operand(left)
                b = parse_int_operand(right)
                if op == "*":
                    left = digits_of_int(a * b)
                elif op == "/":
                    left = digits_of_int(trunc_div(a, b))
                else:
                    left = digits_of_int(trunc_mod(a, b))

    def eval_colon(self, evaluate: bool) -> str:
        """Level 6: `:`, the regex match, tighter than any arithmetic.

        Args:
            evaluate (bool): False inside a branch already decided.

        Returns:
            str: the value of the chain.

        Raises:
            ExprError: a pattern is one glibc would refuse.
        """
        left = self.eval_keyword(evaluate)
        while self.nextarg(":"):
            right = self.eval_keyword(evaluate)
            if evaluate:
                left = docolon(left, right)
        return left

    def eval_keyword(self, evaluate: bool) -> str:
        """The keyword operators and `+ TOKEN`, all above the primaries.

        `+` consumes the next argv word unconditionally and pushes it as
        a literal string, whatever it spells: `expr + length` is
        `length` and `expr + '('` is `(`. It does not recurse, so
        `expr + + hello` and `expr + length abcde` are syntax errors --
        the quoted token eats the operator and the next word is left
        with no slot.

        `length` counts bytes, which is what it costs to have every
        value be a byte view: `len` of one is already a byte count, so
        there is nothing here to special-case.

        Args:
            evaluate (bool): False inside a branch already decided.

        Returns:
            str: the value of the primary.

        Raises:
            ExprError: the line ends where an operand was needed.
        """
        if self.nextarg("+"):
            self.require_more_args()
            return self.take()
        if self.nextarg("length"):
            return str(len(self.eval_keyword(evaluate)))
        if self.nextarg("match"):
            left = self.eval_keyword(evaluate)
            right = self.eval_keyword(evaluate)
            return docolon(left, right) if evaluate else left
        if self.nextarg("index"):
            left = self.eval_keyword(evaluate)
            right = self.eval_keyword(evaluate)
            return do_index(left, right)
        if self.nextarg("substr"):
            text = self.eval_keyword(evaluate)
            pos_arg = self.eval_keyword(evaluate)
            len_arg = self.eval_keyword(evaluate)
            return do_substr(text, pos_arg, len_arg)
        return self.eval_primary(evaluate)

    def eval_primary(self, evaluate: bool) -> str:
        """A parenthesised expression, or a bare word.

        Args:
            evaluate (bool): False inside a branch already decided.

        Returns:
            str: the value.

        Raises:
            ExprError: the line ends where an operand was needed, a
                parenthesis is never closed, a `)` stands where a
                primary belongs, or the nesting is deeper than
                MAX_NESTING.
        """
        self.require_more_args()
        if self.nextarg("("):
            self.depth += 1
            if self.depth > MAX_NESTING:
                raise ExprError(NESTING_TOO_DEEP)
            value = self.eval_or(evaluate)
            self.depth -= 1
            if not self.nextarg(")"):
                raise ExprError(expecting_close(self.peek(), self.prev()))
            return value
        if self.peek() == ")":
            raise ExprError(UNEXPECTED_CLOSE)
        return self.take()


def _expr_eval(args: list[str]) -> tuple[str, int]:
    """Evaluate a whole expr line.

    Args:
        args (list[str]): the expression words as byte views, `--`
            already consumed by the option parser.

    Returns:
        tuple[str, int]: the value to print, as a byte view, and the
            exit code. GNU exits 1 when the value is false even on full
            success, so exit 1 means "the answer was zero or empty" and
            exit 2 is the only error status.

    Raises:
        ExprError: anything GNU refuses.
    """
    parser = ExprParser(args)
    value = parser.eval_or(True)
    if not parser.at_end():
        raise ExprError(unexpected_argument(parser.args[parser.pos]))
    return value, 1 if is_null(value) else 0


@command("expr", resource=None, spec=SPECS["expr"], provision=pure_provision)
async def expr(accessor: Accessor, paths: list[PathSpec] | None,
               texts: list[str],
               opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        return None, IOResult(exit_code=2,
                              stderr=from_byte_view(MISSING_OPERAND))
    try:
        result, exit_code = _expr_eval([to_byte_view(t) for t in texts])
    except ExprError as exc:
        # GNU writes the refusal to stderr, nothing to stdout, and exits
        # 2; exit 1 is reserved for a zero-valued success. The
        # diagnostic quotes a byte view of the offending word, so it
        # leaves through the same door the value does.
        return None, IOResult(exit_code=2, stderr=from_byte_view(f"{exc}\n"))
    return from_byte_view(result + "\n"), IOResult(exit_code=exit_code)
