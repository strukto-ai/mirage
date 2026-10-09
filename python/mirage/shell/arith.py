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

from collections.abc import Callable, Mapping

from mirage.shell.constants import (
    ARITH_ASSIGN_OPS,
    ARITH_BLANKS,
    ARITH_LITERAL,
    ARITH_MAX_DEPTH,
    ARITH_NAME,
    ARITH_OPERATOR,
    ARITH_PRECEDENCE,
    ARITH_SIGN,
    ARITH_UNARY_OPS,
    ARITH_WRAP,
)
from mirage.shell.errors import ArithError, ReadonlyError, UnboundVariable
from mirage.shell.types import (
    ArithResult,
    ArithTokenKind,
    ArithWrite,
    ElementOps,
)


def _matching_bracket(expr: str, start: int) -> int | None:
    """Index of the ``]`` closing the ``[`` at ``start``, quote-aware.

    Quotes matter because an associative key may hold a bracket
    (``m["a]b"]``); nesting matters because an indexed subscript may
    hold another reference (``a[b[0]]``).

    Args:
        expr (str): the whole expression.
        start (int): index of the opening bracket.

    Returns:
        int | None: the index, or None when the bracket never closes.
    """
    depth = 0
    i = start
    n = len(expr)
    while i < n:
        ch = expr[i]
        if ch in "\"'":
            close = expr.find(ch, i + 1)
            if close == -1:
                return None
            i = close + 1
            continue
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return None


def wrap_int64(value: int) -> int:
    """``value`` wrapped to a signed 64-bit integer, as bash's arithmetic
    wraps.

    Args:
        value (int): any integer.
    """
    value &= ARITH_WRAP - 1
    return value - ARITH_WRAP if value & ARITH_SIGN else value


def _base_digit(ch: str, base: int) -> int:
    """The value of one digit of a ``base#digits`` constant.

    Args:
        ch (str): the digit.
        base (int): the constant's base; below 37 upper- and lowercase
            letters are interchangeable, above it uppercase continues
            the range.
    """
    if ch.isdigit():
        return ord(ch) - ord("0")
    if "a" <= ch <= "z":
        return ord(ch) - ord("a") + 10
    if "A" <= ch <= "Z":
        return ord(ch) - ord("A") + (10 if base <= 36 else 36)
    if ch == "@":
        return 62
    return 63


def _digits_value(digits: str, base: int) -> int | None:
    """The value of ``digits`` in ``base``, or None when one is too great.

    Args:
        digits (str): the digits.
        base (int): the base, 2 to 64.
    """
    value = 0
    for ch in digits:
        digit = _base_digit(ch, base)
        if digit >= base:
            return None
        value = value * base + digit
    return value


def _constant(text: str) -> int | str:
    """The value of an integer constant, or what bash says of a bad one.

    Decimal, octal after a leading ``0``, hexadecimal after ``0x`` (bare
    ``0x`` is 0), or ``base#digits`` for a base from 2 to 64 written as
    a constant itself; the value wraps to 64 bits.

    Args:
        text (str): the constant as read.
    """
    if "#" in text:
        base_text, _, digits = text.partition("#")
        base = _constant(base_text)
        if isinstance(base, str):
            return base
        if base < 2 or base > 64:
            return "invalid arithmetic base"
        if not digits:
            return "invalid integer constant"
        value = _digits_value(digits, base)
    elif text[:2] in ("0x", "0X"):
        value = _digits_value(text[2:], 16)
    elif text.startswith("0"):
        value = _digits_value(text, 8)
    else:
        value = _digits_value(text, 10)
    if value is None:
        return "value too great for base"
    return wrap_int64(value)


def _binop(op: str, a: int, b: int) -> int:
    """One binary operator over 64-bit wrapping integers, ``/``, ``%`` and
    ``**`` aside.

    Args:
        op (str): the operator.
        a (int): the left value.
        b (int): the right value.
    """
    if op == "+":
        return wrap_int64(a + b)
    if op == "-":
        return wrap_int64(a - b)
    if op == "*":
        return wrap_int64(a * b)
    if op == "<<":
        return wrap_int64(a << (b & 63))
    if op == ">>":
        return a >> (b & 63)
    if op == "&":
        return a & b
    if op == "|":
        return a | b
    if op == "^":
        return a ^ b
    if op == "==":
        return int(a == b)
    if op == "!=":
        return int(a != b)
    if op == "<":
        return int(a < b)
    if op == "<=":
        return int(a <= b)
    if op == ">":
        return int(a > b)
    return int(a >= b)


def _power(base: int, exponent: int) -> int:
    """``base ** exponent`` modulo 2**64.

    Args:
        base (int): the base.
        exponent (int): a non-negative exponent.
    """
    return wrap_int64(pow(base, exponent, ARITH_WRAP))


def _split_target(target: str) -> tuple[str, str | None]:
    """A target's name and its subscript, None for a bare name.

    Args:
        target (str): the name, with its subscript if it has one.
    """
    name, bracket, rest = target.partition("[")
    return name, rest[:-1] if bracket else None


class _Reader:
    """Reads one arithmetic expression and evaluates it as it goes, as
    bash does.

    A token is read only when the grammar needs it, and every value is
    computed the moment its operands are, so an assignment before an
    error has already been made (``x=7, 1+`` leaves x at 7) and an error
    names the text from the token the reader stood on (``tp``). Inside
    the branch ``&&``, ``||`` or ``?:`` skips (``skip``) nothing is read
    from a variable or written to one and a zero divisor is no error, but
    the grammar is still checked, an integer constant still judged and a
    negative exponent still refused.

    Args:
        record (_ArithRecord): the evaluation the expression belongs to.
        text (str): the expression, leading blanks dropped.
        depth (int): how many variable values deep the expression is.
        subscript (bool): the expression is an indexed subscript.
    """

    def __init__(
        self, record: "_ArithRecord", text: str, depth: int, subscript: bool
    ) -> None:
        self.record = record
        self.text = text
        self.depth = depth
        self.subscript = subscript
        self.pos = 0
        self.tp = 0
        self.kind: ArithTokenKind = "end"
        self.tok = ""
        self.value = 0
        self.skip = 0

    def fail(self, message: str, at: int | None = None) -> ArithError:
        """The error bash reports at the token the reader stands on.

        Args:
            message (str): what went wrong.
            at (int | None): where the error token starts, when it is not
                the reader's own token.
        """
        start = self.tp if at is None else at
        return ArithError(message, self.text, self.text[start:])

    def advance(self) -> None:
        """Read the next token.

        ``++`` and ``--`` after a name are its postfix operators, before
        a name (blanks between allowed) its prefix ones, and anywhere
        else two signs (``1++2`` is ``1 + +2``). A name joined to a
        ``[`` takes its subscript along unread. At the end the reader
        stays on the last token, which an error then names.
        """
        text = self.text
        pos = self.pos
        n = len(text)
        while pos < n and text[pos] in ARITH_BLANKS:
            pos += 1
        after_name = self.kind == "name"
        if pos >= n:
            self.pos, self.kind, self.tok = pos, "end", ""
            return
        self.tp = pos
        name = ARITH_NAME.match(text, pos)
        if name is not None:
            end = name.end()
            if end < n and text[end] == "[":
                close = _matching_bracket(text, end)
                if close is None:
                    raise self.fail("bad array subscript")
                end = close + 1
            self.pos, self.kind, self.tok = end, "name", text[pos:end]
            return
        constant = ARITH_LITERAL.match(text, pos)
        if constant is not None:
            value = _constant(constant[0])
            if isinstance(value, str):
                raise ArithError(value, text[: constant.end()], constant[0])
            self.pos, self.kind, self.tok = constant.end(), "num", constant[0]
            self.value = value
            return
        operator = ARITH_OPERATOR.match(text, pos)
        if operator is None:
            self.pos, self.kind, self.tok = pos + 1, "bad", text[pos]
            return
        op = operator[0]
        if op in ("++", "--"):
            if after_name:
                self.pos, self.kind, self.tok = pos + 2, "post", op
                return
            ahead = pos + 2
            while ahead < n and text[ahead] in ARITH_BLANKS:
                ahead += 1
            if ARITH_NAME.match(text, ahead) is not None:
                self.pos, self.kind, self.tok = pos + 2, "pre", op
                return
            op = op[0]
        self.pos, self.kind, self.tok = pos + len(op), "op", op

    def at(self, op: str) -> bool:
        return self.kind == "op" and self.tok == op

    def stray(self, message: str) -> ArithError:
        """The error for a token where an operator or closer belongs.

        Args:
            message (str): what a token bash can read means there.
        """
        if self.kind == "bad":
            return self.fail("syntax error: invalid arithmetic operator")
        return self.fail(message)

    def run(self) -> int:
        self.advance()
        if self.kind == "end":
            return 0
        value = self.comma()
        if self.kind != "end":
            raise self.stray("syntax error in expression")
        return value

    def comma(self) -> int:
        value = self.assign()
        while self.at(","):
            self.advance()
            value = self.assign()
        return value

    def assign(self) -> int:
        if self.kind == "name":
            saved = (self.pos, self.tp, self.kind, self.tok)
            target = self.tok
            self.advance()
            if self.kind == "op" and self.tok in ARITH_ASSIGN_OPS:
                return self.assignment(target)
            self.pos, self.tp, self.kind, self.tok = saved
        value = self.ternary()
        if self.kind == "op" and self.tok in ARITH_ASSIGN_OPS:
            raise self.fail("attempted assignment to non-variable")
        return value

    def assignment(self, target: str) -> int:
        """An assignment to ``target``, the reader on its operator.

        bash evaluates a plain assignment's right side before it resolves
        the target's subscript (``x=0, a[x++]=x++`` stores 0 at index 1),
        and a compound one reads its target before the right side.

        Args:
            target (str): the name, with its subscript if it has one.
        """
        op = self.tok
        self.advance()
        divisor = self.tp
        if self.skip:
            return self.assign()
        record = self.record
        if op == "=":
            value = self.assign()
            key = record.key_of(target, self.depth)
        else:
            key = record.key_of(target, self.depth)
            current = record.read_target(
                target, key, self.depth, self.subscript
            )
            value = self.apply(op[:-1], current, self.assign(), divisor)
        record.write_target(target, key, value, self.subscript)
        return value

    def ternary(self) -> int:
        cond = self.binary(1)
        if not self.at("?"):
            return cond
        self.advance()
        if self.kind == "end" or self.at(":"):
            raise self.fail("expression expected")
        self.skip += cond == 0
        then = self.comma()
        self.skip -= cond == 0
        if not self.at(":"):
            raise self.stray("`:' expected for conditional expression")
        self.advance()
        if self.kind == "end":
            raise self.fail("expression expected")
        self.skip += cond != 0
        other = self.ternary()
        self.skip -= cond != 0
        return then if cond else other

    def binary(self, floor: int) -> int:
        """Binary operators binding at least as tightly as ``floor``.

        Args:
            floor (int): the loosest precedence this level takes.
        """
        left = self.unary()
        while self.kind == "op":
            op = self.tok
            precedence = ARITH_PRECEDENCE.get(op, 0)
            if precedence < floor:
                break
            self.advance()
            divisor = self.tp
            if op in ("&&", "||"):
                skipped = (left == 0) == (op == "&&")
                self.skip += skipped
                right = self.binary(precedence + 1)
                self.skip -= skipped
                left = int(
                    left != 0 and right != 0
                    if op == "&&"
                    else left != 0 or right != 0
                )
                continue
            right = self.binary(precedence + (op != "**"))
            left = self.apply(op, left, right, divisor)
        return left

    def apply(self, op: str, a: int, b: int, divisor: int) -> int:
        """One binary operator over 64-bit wrapping integers.

        Division truncates toward zero and ``%`` takes the dividend's
        sign, as in C.

        Args:
            op (str): the operator.
            a (int): the left value.
            b (int): the right value.
            divisor (int): where the right operand starts, which a
                division by 0 names.
        """
        if op in ("/", "%"):
            if b == 0:
                if self.skip:
                    return 0
                raise self.fail("division by 0", divisor)
            quotient = abs(a) // abs(b)
            if (a < 0) != (b < 0):
                quotient = -quotient
            return wrap_int64(quotient if op == "/" else a - quotient * b)
        if op == "**":
            if b < 0:
                raise self.fail("exponent less than 0")
            return _power(a, b)
        return _binop(op, a, b)

    def unary(self) -> int:
        if self.kind == "op" and self.tok in ARITH_UNARY_OPS:
            op = self.tok
            self.advance()
            value = self.unary()
            if op == "!":
                return int(value == 0)
            if op == "~":
                return wrap_int64(~value)
            if op == "-":
                return wrap_int64(-value)
            return value
        if self.kind == "pre":
            step = 1 if self.tok == "++" else -1
            self.advance()
            target = self.tok
            self.advance()
            if self.kind == "post":
                raise self.fail(f"{self.tok}: assignment requires lvalue")
            return self.step(target, step, True)
        return self.primary()

    def step(self, target: str, step: int, prefix: bool) -> int:
        """``++`` or ``--`` on ``target``: the new value before it, the
        old one after it.

        Args:
            target (str): the name, with its subscript if it has one.
            step (int): 1 or -1.
            prefix (bool): the operator stands before the name.
        """
        if self.skip:
            return 0
        record = self.record
        key = record.key_of(target, self.depth)
        value = record.read_target(target, key, self.depth, self.subscript)
        stepped = wrap_int64(value + step)
        record.write_target(target, key, stepped, self.subscript)
        return stepped if prefix else value

    def primary(self) -> int:
        if self.at("("):
            self.advance()
            value = self.comma()
            if not self.at(")"):
                raise self.stray("missing `)'")
            self.advance()
            return value
        if self.kind == "num":
            value = self.value
            self.advance()
            return value
        if self.kind == "name":
            target = self.tok
            self.advance()
            if self.kind == "post":
                step = 1 if self.tok == "++" else -1
                self.advance()
                return self.step(target, step, False)
            if self.skip:
                return 0
            record = self.record
            key = record.key_of(target, self.depth)
            return record.read_target(target, key, self.depth, self.subscript)
        raise self.fail("syntax error: operand expected")


class _ArithRecord:
    """One evaluation: what it reads and every write it makes.

    Reads resolve through ``updates`` first, then ``env``; every write
    lands in ``updates`` (or ``elem_updates`` for an element) and in
    ``writes``, the one ordered record across both kinds, so the caller
    lands them in the order the expression made them. A variable's value
    and an indexed subscript are expressions of their own, read in this
    same record (``x='y=5'; $((x))`` leaves y at 5) one level deeper. A
    write to a name ``frozen`` holds stops the evaluation there
    (``ReadonlyError``).

    Args:
        env (Mapping[str, str]): variable environment for reads.
        elements (ElementOps | None): array-element callbacks.
        read_var (Callable[[str], str | None] | None): dynamic reads.
        wrote_var (Callable[[str, str], None] | None): told of each
            scalar write.
        nounset (bool): ``set -u`` for the names read.
        frozen (Callable[[str], str | None] | None): the readonly name a
            write reaches, or None.
    """

    def __init__(
        self,
        env: Mapping[str, str],
        elements: ElementOps | None,
        read_var: Callable[[str], str | None] | None,
        wrote_var: Callable[[str, str], None] | None,
        nounset: bool,
        frozen: Callable[[str], str | None] | None,
    ) -> None:
        self.env = env
        self.elements = elements
        self.read_var = read_var
        self.wrote_var = wrote_var
        self.nounset = nounset
        self.frozen = frozen
        self.updates: dict[str, str] = {}
        self.elem_updates: dict[tuple[str, str], str] = {}
        self.writes: list[ArithWrite] = []

    def evaluate(self, text: str, depth: int, subscript: bool) -> int:
        """The value of ``text`` read as an expression in this record.

        Args:
            text (str): the expression.
            depth (int): how many variable values deep it is.
            subscript (bool): it is an indexed subscript.
        """
        text = text.lstrip(ARITH_BLANKS)
        if depth >= ARITH_MAX_DEPTH and text:
            raise ArithError("expression recursion level exceeded", text, text)
        return _Reader(self, text, depth, subscript).run()

    def coerce(self, raw: str | None, depth: int, subscript: bool) -> int:
        """A variable's value as a number: its text read as an expression.

        Args:
            raw (str | None): the stored text, None when unset.
            depth (int): the depth of the expression that read it.
            subscript (bool): that expression is a subscript's.
        """
        raw = raw or ""
        number = raw.strip(ARITH_BLANKS)
        if number.isdecimal() and number.isascii() and number[0] != "0":
            return wrap_int64(int(number))
        return self.evaluate(raw, depth + 1, subscript)

    def merged_env(self) -> dict[str, str]:
        merged = {
            name: value
            for name in self.env
            if (value := self.env.get(name)) is not None
        }
        merged.update(self.updates)
        return merged

    def key_of(self, target: str, depth: int) -> str | None:
        """The canonical element key a target names, None for a scalar.

        Resolved once per reference: a compound assignment or a ``++``
        reads and writes the same element, and a subscript that draws
        (``a[RANDOM]+=1``) draws once.

        Args:
            target (str): the name, with its subscript if it has one.
            depth (int): the depth of the expression naming it.
        """
        name, inner = _split_target(target)
        if inner is None:
            return None
        elements = self.elements
        if elements is None:
            raise ArithError(
                "syntax error: operand expected", target, target[len(name) :]
            )
        is_assoc = elements.is_assoc
        if is_assoc is not None and is_assoc(name):
            return elements.resolve(name, inner, self.merged_env())
        try:
            index = int(inner.strip())
        except ValueError:
            try:
                index = self.evaluate(inner, depth + 1, True)
            except ArithError as exc:
                exc.in_subscript = True
                raise
        return elements.resolve(name, str(index), self.merged_env())

    def read_target(
        self, target: str, key: str | None, depth: int, subscript: bool
    ) -> int:
        """The value a target holds.

        A bare name a dynamic reader answers (``RANDOM``) is asked first,
        the pending writes next, then the environment; an array's bare
        name reads element 0.

        Args:
            target (str): the name, with its subscript if it has one.
            key (str | None): its element key, None for a scalar.
            depth (int): the depth of the expression reading it.
            subscript (bool): that expression is a subscript's.
        """
        name = _split_target(target)[0]
        if key is not None:
            raw = self.elem_updates.get((name, key))
            if raw is None and self.elements is not None:
                raw = self.elements.read(name, key)
            return self.coerce(raw, depth, subscript)
        if self.read_var is not None:
            dynamic = self.read_var(name)
            if dynamic is not None:
                return self.coerce(dynamic, depth, subscript)
        raw = self.updates.get(name)
        if raw is None:
            value = self.env.get(name)
            if value is None and self.elements is not None:
                value = self.elements.read(name, "0")
            if (
                value is None
                and self.nounset
                and not (
                    self.elements is not None
                    and self.elements.holds_array is not None
                    and self.elements.holds_array(name)
                )
            ):
                raise UnboundVariable(name)
            raw = "" if value is None else str(value)
        return self.coerce(raw, depth, subscript)

    def write_target(
        self, target: str, key: str | None, value: int, subscript: bool
    ) -> None:
        """Record a write, or refuse one to a readonly name.

        Args:
            target (str): the name, with its subscript if it has one.
            key (str | None): its element key, None for a scalar.
            value (int): the value written.
            subscript (bool): the write is made inside a subscript.
        """
        name = _split_target(target)[0]
        refused = self.frozen(name) if self.frozen is not None else None
        if refused is not None:
            raise ReadonlyError(refused, subscript)
        text = str(value)
        self.writes.append(ArithWrite(name, key, text))
        if key is not None:
            self.elem_updates[(name, key)] = text
            return
        self.updates[name] = text
        if self.wrote_var is not None:
            self.wrote_var(name, text)


def evaluate_arith(
    expr: str,
    env: Mapping[str, str],
    depth: int = 0,
    elements: ElementOps | None = None,
    read_var: Callable[[str], str | None] | None = None,
    wrote_var: Callable[[str, str], None] | None = None,
    nounset: bool = False,
    frozen: Callable[[str], str | None] | None = None,
) -> ArithResult:
    """Evaluate a bash arithmetic expression.

    bash's grammar over 64-bit wrapping integers, read and evaluated in
    one pass as bash does (``_Reader``): comma sequences, assignment
    operators, the ternary, short-circuit ``&&``/``||``, the bitwise,
    comparison, shift and arithmetic operators, right-grouping ``**``,
    unary operators, ``++``/``--``, and integer constants in any base
    from 2 to 64. A variable whose value is not a plain number is read as
    an expression of its own (``x="1+2"; $((x))`` is 3). An error is
    worded as bash's line, naming the innermost expression it happened in
    (``x='1+'; $((x+1))`` names ``1+``).

    Element references (``a[i]``, ``m[key]``) resolve and assign through
    ``elements``; with None every subscript is a syntax error, which is
    what an evaluation with no session behind it can honestly say.

    Args:
        expr (str): the expression text, already ``$``-expanded.
        env (Mapping[str, str]): variable environment for reads.
        depth (int): how many variable values deep ``expr`` is.
        elements (ElementOps | None): array-element callbacks; None
            outside a session.
        read_var (Callable[[str], str | None] | None): dynamic scalar
            reads, asked before the pending assignments and the
            environment; a None answer falls back to them.
        wrote_var (Callable[[str, str], None] | None): told of every
            scalar assignment as it is made, name and value, so a dynamic
            name's reader can act on it at once (bash seeds ``RANDOM`` at
            the assignment, and the reads after it draw from the seed)
            where the caller lands the assignments only afterwards.
        nounset (bool): ``set -u`` for the names the expression reads:
            one that no variable holds raises UnboundVariable instead of
            reading 0.
        frozen (Callable[[str], str | None] | None): the readonly
            variable a write to a name reaches, through a reference, or
            None; None refuses none.

    Returns:
        ArithResult: the value plus the assignments made, in order, for
        the caller to apply to the session.

    Raises:
        ArithError: bash's arithmetic error line; its ``writes`` are the
            assignments made before it.
        ReadonlyError: an assignment named a ``frozen`` name; the
            evaluation stopped there.
    """
    record = _ArithRecord(env, elements, read_var, wrote_var, nounset, frozen)
    try:
        value = record.evaluate(expr, depth, False)
    except (ArithError, ReadonlyError) as exc:
        exc.writes = tuple(record.writes)
        raise
    return ArithResult(value, tuple(record.writes))
