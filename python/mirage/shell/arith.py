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
from typing import Any

from mirage.shell.constants import (ARITH_ASSIGN_OPS, ARITH_ELEM,
                                    ARITH_MAX_DEPTH, ARITH_NAME, ARITH_SIGN,
                                    ARITH_TOKEN, ARITH_WRAP)
from mirage.shell.errors import ArithError
from mirage.shell.types import ArithResult, ArithWrite, ElementOps


def _matching_bracket(expr: str, start: int) -> int:
    """Index of the ``]`` closing the ``[`` at ``start``, quote-aware.

    Quotes matter because an associative key may hold a bracket
    (``m["a]b"]``); nesting matters because an indexed subscript may
    hold another reference (``a[b[0]]``).

    Args:
        expr (str): the whole expression.
        start (int): index of the opening bracket.
    """
    depth = 0
    i = start
    n = len(expr)
    while i < n:
        ch = expr[i]
        if ch in "\"'":
            close = expr.find(ch, i + 1)
            if close == -1:
                break
            i = close + 1
            continue
        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise ArithError('syntax error: "]" expected')


def _tokenize(expr: str) -> list[str]:
    tokens: list[str] = []
    pos = 0
    n = len(expr)
    while pos < n:
        match = ARITH_TOKEN.match(expr, pos)
        if match is None:
            raise ArithError(f'syntax error: invalid character "{expr[pos]}"')
        kind = match.lastgroup
        end = match.end()
        if kind == "name" and end < n and expr[end] == "[":
            # A name adjacent to a bracket is one element reference, so
            # the subscript rides inside the token: its interior is not
            # arithmetic (an associative key can be any text at all) and
            # only the resolver knows which grammar applies.
            close = _matching_bracket(expr, end)
            tokens.append(expr[match.start():close + 1])
            pos = close + 1
            continue
        pos = end
        if kind == "ws":
            continue
        if kind == "bad":
            raise ArithError(f'syntax error: invalid character "{match[0]}"')
        tokens.append(match[0])
    return tokens


def _target_node(tok: str) -> tuple[Any, ...] | None:
    """The lvalue node one token spells, or None when it spells none.

    Args:
        tok (str): the token to classify.
    """
    if ARITH_NAME.fullmatch(tok):
        return ("var", tok)
    elem = ARITH_ELEM.fullmatch(tok)
    if elem is not None:
        return ("elem", elem.group(1), elem.group(2))
    return None


def _wrap(value: int) -> int:
    value &= ARITH_WRAP - 1
    return value - ARITH_WRAP if value & ARITH_SIGN else value


def _trunc_div(a: int, b: int) -> int:
    if b == 0:
        raise ArithError("division by 0")
    q = a // b
    if q < 0 and q * b != a:
        q += 1
    return q


def _trunc_mod(a: int, b: int) -> int:
    return a - _trunc_div(a, b) * b


def _base_digit(ch: str, base: int) -> int:
    if ch.isdigit():
        return ord(ch) - ord("0")
    if "a" <= ch <= "z":
        return ord(ch) - ord("a") + 10
    if "A" <= ch <= "Z":
        # Below base 37 upper- and lowercase are interchangeable; above,
        # uppercase continues the digit range (bash base#value rules).
        return ord(ch) - ord("A") + (10 if base <= 36 else 36)
    if ch == "@":
        return 62
    return 63


def _parse_base_literal(text: str) -> int:
    base_text, _, digits = text.partition("#")
    base = int(base_text)
    if base < 2 or base > 64:
        raise ArithError(f'invalid arithmetic base (error token is "{text}")')
    value = 0
    for ch in digits:
        digit = _base_digit(ch, base)
        if digit >= base:
            raise ArithError(f"value too great for base (error token is "
                             f'"{text}")')
        value = value * base + digit
    return value


def _parse_literal(text: str) -> int:
    if "#" in text:
        return _parse_base_literal(text)
    if text.lower().startswith("0x"):
        return int(text, 16)
    if text.startswith("0") and text != "0":
        try:
            return int(text, 8)
        except ValueError:
            raise ArithError(f"value too great for base (error token is "
                             f'"{text}")') from None
    return int(text)


class ArithParser:
    """Recursive-descent parser producing tuple AST nodes.

    Grammar mirrors bash arithmetic precedence (comma, assignment,
    ternary, ``||``, ``&&``, ``|``, ``^``, ``&``, equality, relational,
    shift, additive, multiplicative, ``**``, unary, ``++``/``--``,
    primary). Evaluation is separate so ``&&``/``||``/ternary can
    short-circuit side effects.
    """

    def __init__(self, tokens: list[str]) -> None:
        self.tokens = tokens
        self.pos = 0

    def peek(self) -> str | None:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def take(self) -> str:
        tok = self.peek()
        if tok is None:
            raise ArithError("syntax error: operand expected")
        self.pos += 1
        return tok

    def expect(self, tok: str) -> None:
        if self.take() != tok:
            raise ArithError(f'syntax error: "{tok}" expected')

    def parse(self) -> tuple[Any, ...]:
        node = self.comma()
        if self.peek() is not None:
            raise ArithError(f'syntax error: unexpected token "{self.peek()}"')
        return node

    def comma(self) -> tuple[Any, ...]:
        parts = [self.assign()]
        while self.peek() == ",":
            self.take()
            parts.append(self.assign())
        return parts[0] if len(parts) == 1 else ("comma", parts)

    def assign(self) -> tuple[Any, ...]:
        tok = self.peek()
        if (tok is not None and self.pos + 1 < len(self.tokens)
                and self.tokens[self.pos + 1] in ARITH_ASSIGN_OPS
                and _target_node(tok) is not None):
            target = _target_node(self.take())
            op = self.take()
            return ("assign", target, op, self.assign())
        return self.ternary()

    def ternary(self) -> tuple[Any, ...]:
        cond = self.logic_or()
        if self.peek() != "?":
            return cond
        self.take()
        then = self.assign()
        self.expect(":")
        other = self.assign()
        return ("ternary", cond, then, other)

    def logic_or(self) -> tuple[Any, ...]:
        node = self.logic_and()
        while self.peek() == "||":
            self.take()
            node = ("logic", "||", node, self.logic_and())
        return node

    def logic_and(self) -> tuple[Any, ...]:
        node = self.bit_or()
        while self.peek() == "&&":
            self.take()
            node = ("logic", "&&", node, self.bit_or())
        return node

    def bit_or(self) -> tuple[Any, ...]:
        node = self.bit_xor()
        while self.peek() == "|":
            self.take()
            node = ("binop", "|", node, self.bit_xor())
        return node

    def bit_xor(self) -> tuple[Any, ...]:
        node = self.bit_and()
        while self.peek() == "^":
            self.take()
            node = ("binop", "^", node, self.bit_and())
        return node

    def bit_and(self) -> tuple[Any, ...]:
        node = self.equality()
        while self.peek() == "&":
            self.take()
            node = ("binop", "&", node, self.equality())
        return node

    def equality(self) -> tuple[Any, ...]:
        node = self.relational()
        while self.peek() in ("==", "!="):
            op = self.take()
            node = ("binop", op, node, self.relational())
        return node

    def relational(self) -> tuple[Any, ...]:
        node = self.shift()
        while self.peek() in ("<", "<=", ">", ">="):
            op = self.take()
            node = ("binop", op, node, self.shift())
        return node

    def shift(self) -> tuple[Any, ...]:
        node = self.additive()
        while self.peek() in ("<<", ">>"):
            op = self.take()
            node = ("binop", op, node, self.additive())
        return node

    def additive(self) -> tuple[Any, ...]:
        node = self.multiplicative()
        while self.peek() in ("+", "-"):
            op = self.take()
            node = ("binop", op, node, self.multiplicative())
        return node

    def multiplicative(self) -> tuple[Any, ...]:
        node = self.power()
        while self.peek() in ("*", "/", "%"):
            op = self.take()
            node = ("binop", op, node, self.power())
        return node

    def power(self) -> tuple[Any, ...]:
        node = self.unary()
        if self.peek() == "**":
            self.take()
            return ("binop", "**", node, self.power())
        return node

    def unary(self) -> tuple[Any, ...]:
        tok = self.peek()
        if tok in ("!", "~", "-", "+"):
            self.take()
            return ("unary", tok, self.unary())
        if tok in ("++", "--"):
            self.take()
            target = _target_node(self.take())
            if target is None:
                raise ArithError(f'syntax error: "{tok}" requires a variable')
            return ("pre", tok, target)
        return self.postfix()

    def postfix(self) -> tuple[Any, ...]:
        node = self.primary()
        if self.peek() in ("++", "--") and node[0] in ("var", "elem"):
            op = self.take()
            return ("post", op, node)
        return node

    def primary(self) -> tuple[Any, ...]:
        tok = self.take()
        if tok == "(":
            node = self.comma()
            self.expect(")")
            return node
        target = _target_node(tok)
        if target is not None:
            return target
        try:
            return ("num", _parse_literal(tok))
        except ValueError:
            raise ArithError(f'syntax error: unexpected token "{tok}"') \
                from None


class ArithEvaluator:
    """Evaluates the tuple AST against an env, recording assignments.

    Reads resolve through ``updates`` first, then ``env``; every write
    lands in ``updates`` (or ``elem_updates`` for an element lvalue) so
    the caller decides what to apply to the session (bash arithmetic
    assignments are real assignments). ``writes`` keeps the one
    ordered record across both kinds, keyed by target and moved to the
    end on each write, so the caller lands them in the order the
    expression made them.
    """

    def __init__(self,
                 env: Mapping[str, str],
                 updates: dict[str, str],
                 elem_updates: dict[tuple[str, str], str],
                 writes: dict[tuple[str, str | None], str],
                 depth: int,
                 elements: ElementOps | None,
                 read_var: Callable[[str], str | None] | None,
                 wrote_var: Callable[[str, str], None] | None = None) -> None:
        self.env = env
        self.updates = updates
        self.elem_updates = elem_updates
        self.writes = writes
        self.depth = depth
        self.elements = elements
        self.read_var = read_var
        self.wrote_var = wrote_var

    def _merged_env(self) -> dict[str, str]:
        merged = {
            name: value
            for name in self.env if (value := self.env.get(name)) is not None
        }
        merged.update(self.updates)
        return merged

    def _coerce(self, raw: str | None) -> int:
        raw = (raw or "").strip()
        if not raw:
            return 0
        try:
            return _parse_literal(raw)
        except (ValueError, ArithError):
            return self._nested(raw)

    def _nested(self, raw: str) -> int:
        """Evaluate text as an expression in this expression's record.

        bash evaluates a variable's stored text, and an indexed
        subscript, in the same context as the expression around them:
        an assignment they make lands with the expression's own
        (``x='y=5'; $((x))`` leaves y at 5, ``$((a[x=5] + x))`` is 12),
        a name they read sees the pending updates, and a ``RANDOM`` seed
        reaches the reader. So the nested run shares this evaluator's
        record rather than starting a fresh one.

        Args:
            raw (str): the text to evaluate.
        """
        if self.depth >= ARITH_MAX_DEPTH:
            raise ArithError(f"expression recursion level exceeded (error "
                             f'token is "{raw}")')
        nested = ArithEvaluator(self.env, self.updates, self.elem_updates,
                                self.writes, self.depth + 1, self.elements,
                                self.read_var, self.wrote_var)
        return nested.run(ArithParser(_tokenize(raw)).parse())

    def lookup(self, name: str) -> int:
        # A dynamic name is asked first: the reader has been told of every
        # assignment this expression made (`wrote_var`), so
        # `RANDOM=42, RANDOM` draws from the new seed rather than reading
        # the seed back out of the pending update.
        if self.read_var is not None:
            dynamic = self.read_var(name)
            if dynamic is not None:
                return self._coerce(dynamic)
        raw = self.updates.get(name)
        if raw is None:
            value = self.env.get(name)
            if value is None and self.elements is not None:
                # A bare array name reads as element 0 (`a=(4 5)` then
                # `$((a))` is 4); the env holds scalars only, so the
                # element resolver answers for the arrays.
                value = self.elements.read(name, "0")
            raw = "" if value is None else str(value)
        return self._coerce(raw)

    def elem_key(self, name: str, subscript: str) -> str:
        if self.elements is None:
            raise ArithError('syntax error: operand expected (error token '
                             'is "[")')
        is_assoc = self.elements.is_assoc
        if is_assoc is not None and not is_assoc(name):
            # An indexed subscript is arithmetic in this expression's
            # own record (`_nested`), so what it assigns the rest of the
            # expression reads and the expression lands; the resolver
            # only normalizes the index it is handed (a negative one
            # counts from the extent). A literal index skips the run.
            try:
                index = int(subscript.strip())
            except ValueError:
                index = self._nested(subscript)
            return self.elements.resolve(name, str(index), self._merged_env())
        return self.elements.resolve(name, subscript, self._merged_env())

    def key_of(self, target: tuple[Any, ...]) -> str | None:
        """The canonical element key of a target, None for a scalar.

        Resolved once per reference: a compound assignment or a ``++``
        reads and writes the same element, and a subscript that draws
        (``a[RANDOM]+=1``) must draw once, as bash's does.

        Args:
            target (tuple[Any, ...]): a ``var`` or ``elem`` target node.
        """
        if target[0] == "var":
            return None
        return self.elem_key(target[1], target[2])

    def read_target(self,
                    target: tuple[Any, ...],
                    key: str | None = None) -> int:
        if target[0] == "var":
            return self.lookup(target[1])
        if key is None:
            key = self.elem_key(target[1], target[2])
        raw = self.elem_updates.get((target[1], key))
        if raw is None and self.elements is not None:
            raw = self.elements.read(target[1], key)
        return self._coerce(raw)

    def write_target(self,
                     target: tuple[Any, ...],
                     value: int,
                     key: str | None = None) -> None:
        text = str(value)
        if target[0] == "var":
            self.updates[target[1]] = text
            self._record(target[1], None, text)
            if self.wrote_var is not None:
                self.wrote_var(target[1], text)
            return
        if key is None:
            key = self.elem_key(target[1], target[2])
        self.elem_updates[(target[1], key)] = text
        self._record(target[1], key, text)

    def _record(self, name: str, key: str | None, text: str) -> None:
        self.writes.pop((name, key), None)
        self.writes[(name, key)] = text

    def run(self, node: tuple[Any, ...]) -> int:
        kind = node[0]
        if kind == "num":
            return node[1]
        if kind in ("var", "elem"):
            return self.read_target(node)
        if kind == "comma":
            value = 0
            for part in node[1]:
                value = self.run(part)
            return value
        if kind == "assign":
            _, target, op, rhs = node
            if op == "=":
                # bash evaluates the right side before it resolves a
                # plain assignment's subscript: `x=0, a[x++]=x++` stores
                # 0 at index 1 and leaves x at 2.
                value = self.run(rhs)
                key = self.key_of(target)
            else:
                # A compound assignment reads its target first, and bash
                # reads it before the right side, which a dynamic name
                # makes observable: `RANDOM=42, RANDOM-=RANDOM` is the
                # first draw minus the second.
                key = self.key_of(target)
                current = self.read_target(target, key)
                value = self.apply_binop(op[:-1], current, self.run(rhs))
            self.write_target(target, value, key)
            return value
        if kind == "ternary":
            _, cond, then, other = node
            return self.run(then) if self.run(cond) != 0 else self.run(other)
        if kind == "logic":
            _, op, left, right = node
            lval = self.run(left)
            if op == "&&":
                return 1 if lval != 0 and self.run(right) != 0 else 0
            return 1 if lval != 0 or self.run(right) != 0 else 0
        if kind == "binop":
            _, op, left, right = node
            return self.apply_binop(op, self.run(left), self.run(right))
        if kind == "unary":
            _, op, operand = node
            value = self.run(operand)
            if op == "!":
                return 0 if value != 0 else 1
            if op == "~":
                return _wrap(~value)
            if op == "-":
                return _wrap(-value)
            return value
        if kind == "pre":
            _, op, target = node
            key = self.key_of(target)
            value = _wrap(
                self.read_target(target, key) + (1 if op == "++" else -1))
            self.write_target(target, value, key)
            return value
        if kind == "post":
            _, op, target = node
            key = self.key_of(target)
            value = self.read_target(target, key)
            self.write_target(target, _wrap(value + (1 if op == "++" else -1)),
                              key)
            return value
        raise ArithError(f"unsupported node: {kind}")

    def apply_binop(self, op: str, a: int, b: int) -> int:
        if op == "+":
            return _wrap(a + b)
        if op == "-":
            return _wrap(a - b)
        if op == "*":
            return _wrap(a * b)
        if op == "/":
            return _wrap(_trunc_div(a, b))
        if op == "%":
            return _wrap(_trunc_mod(a, b))
        if op == "**":
            if b < 0:
                raise ArithError("exponent less than 0")
            return _wrap(a**b)
        if op == "<<":
            return _wrap(a << (b & 63))
        if op == ">>":
            return _wrap(a >> (b & 63))
        if op == "&":
            return _wrap(a & b)
        if op == "|":
            return _wrap(a | b)
        if op == "^":
            return _wrap(a ^ b)
        if op == "==":
            return 1 if a == b else 0
        if op == "!=":
            return 1 if a != b else 0
        if op == "<":
            return 1 if a < b else 0
        if op == "<=":
            return 1 if a <= b else 0
        if op == ">":
            return 1 if a > b else 0
        if op == ">=":
            return 1 if a >= b else 0
        raise ArithError(f'unsupported operator "{op}"')


def evaluate_arith(
        expr: str,
        env: Mapping[str, str],
        depth: int = 0,
        elements: ElementOps | None = None,
        read_var: Callable[[str], str | None] | None = None,
        wrote_var: Callable[[str, str], None] | None = None) -> ArithResult:
    """Evaluate a bash arithmetic expression.

    Implements bash's arithmetic grammar over 64-bit wrapping integers:
    comma sequences, assignment operators, the ternary, short-circuit
    ``&&``/``||``, bitwise/relational/shift/additive/multiplicative
    operators, right-associative ``**``, unary operators, and
    prefix/postfix ``++``/``--``. Division truncates toward zero and
    ``%`` takes the dividend's sign (C semantics, unlike Python's
    floor). A variable whose value is not a plain integer literal is
    evaluated recursively like bash (``x="1+2"; $((x))`` is 3).
    ``base#value`` literals are not supported.

    Element references (``a[i]``, ``m[key]``) resolve and assign through
    ``elements``; with None every subscript is a syntax error, which is
    what an evaluation with no session behind it can honestly say.

    Args:
        expr (str): the expression text, already ``$``-expanded.
        env (Mapping[str, str]): variable environment for reads.
        depth (int): recursion depth for variable re-evaluation.
        elements (ElementOps | None): array-element callbacks; None
            outside a session.
        read_var (Callable[[str], str | None] | None): dynamic scalar
            reads, asked before the pending assignments and the
            environment; a None answer falls back to them. Called only
            for evaluated nodes, including recursive variable expressions.
        wrote_var (Callable[[str, str], None] | None): told of every
            scalar assignment as it is made, name and value, so a dynamic
            name's reader can act on it at once (bash seeds ``RANDOM`` at
            the assignment, and the reads after it draw from the seed)
            where the caller lands the assignments only afterwards.

    Returns:
        ArithResult: the value plus the assignments made, in order, for
        the caller to apply to the session.

    Raises:
        ArithError: on syntax errors, division by zero, or a negative
            exponent, with a bash-style message.
    """
    tokens = _tokenize(expr)
    if not tokens:
        return ArithResult(0)
    node = ArithParser(tokens).parse()
    updates: dict[str, str] = {}
    elem_updates: dict[tuple[str, str], str] = {}
    writes: dict[tuple[str, str | None], str] = {}
    try:
        value = ArithEvaluator(env, updates, elem_updates, writes, depth,
                               elements, read_var, wrote_var).run(node)
    except ArithError as exc:
        exc.writes = _arith_writes(writes)
        raise
    return ArithResult(value, _arith_writes(writes))


def _arith_writes(
        writes: dict[tuple[str, str | None], str]) -> tuple[ArithWrite, ...]:
    """The evaluator's ordered write record as ``ArithWrite`` rows.

    Args:
        writes (dict[tuple[str, str | None], str]): target to value, in
            the order of each target's last write.
    """
    return tuple(
        ArithWrite(name, key, text) for (name, key), text in writes.items())
