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

from collections.abc import Mapping
from typing import Any

from mirage.shell.constants import (ARITH_ASSIGN_OPS, ARITH_MAX_DEPTH,
                                    ARITH_NAME, ARITH_SIGN, ARITH_TOKEN,
                                    ARITH_WRAP)
from mirage.shell.errors import ArithError


def _tokenize(expr: str) -> list[str]:
    tokens: list[str] = []
    for match in ARITH_TOKEN.finditer(expr):
        kind = match.lastgroup
        if kind == "ws":
            continue
        if kind == "bad":
            raise ArithError(f'syntax error: invalid character "{match[0]}"')
        tokens.append(match[0])
    return tokens


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


def _parse_literal(text: str) -> int:
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
        if (self.peek() is not None
                and ARITH_NAME.fullmatch(self.tokens[self.pos])
                and self.pos + 1 < len(self.tokens)
                and self.tokens[self.pos + 1] in ARITH_ASSIGN_OPS):
            name = self.take()
            op = self.take()
            return ("assign", name, op, self.assign())
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
            name = self.take()
            if not ARITH_NAME.fullmatch(name):
                raise ArithError(f'syntax error: "{tok}" requires a variable')
            return ("pre", tok, name)
        return self.postfix()

    def postfix(self) -> tuple[Any, ...]:
        node = self.primary()
        if self.peek() in ("++", "--") and node[0] == "var":
            op = self.take()
            return ("post", op, node[1])
        return node

    def primary(self) -> tuple[Any, ...]:
        tok = self.take()
        if tok == "(":
            node = self.comma()
            self.expect(")")
            return node
        if ARITH_NAME.fullmatch(tok):
            return ("var", tok)
        try:
            return ("num", _parse_literal(tok))
        except ValueError:
            raise ArithError(f'syntax error: unexpected token "{tok}"') \
                from None


class ArithEvaluator:
    """Evaluates the tuple AST against an env, recording assignments.

    Reads resolve through ``updates`` first, then ``env``; every write
    lands in ``updates`` so the caller decides what to apply to the
    session (bash arithmetic assignments are real assignments).
    """

    def __init__(self, env: Mapping[str, str], updates: dict[str, str],
                 depth: int) -> None:
        self.env = env
        self.updates = updates
        self.depth = depth

    def lookup(self, name: str) -> int:
        raw = self.updates.get(name)
        if raw is None:
            value = self.env.get(name, "")
            raw = value if isinstance(value, str) else str(value)
        raw = raw.strip()
        if not raw:
            return 0
        try:
            return _parse_literal(raw)
        except (ValueError, ArithError):
            if self.depth >= ARITH_MAX_DEPTH:
                raise ArithError(
                    f"expression recursion level exceeded (error token is "
                    f'"{raw}")') from None
            result, _ = evaluate_arith(raw, {
                **dict(self.env),
                **self.updates
            },
                                       depth=self.depth + 1)
            return result

    def run(self, node: tuple[Any, ...]) -> int:
        kind = node[0]
        if kind == "num":
            return node[1]
        if kind == "var":
            return self.lookup(node[1])
        if kind == "comma":
            value = 0
            for part in node[1]:
                value = self.run(part)
            return value
        if kind == "assign":
            _, name, op, rhs = node
            rhs_val = self.run(rhs)
            value = (rhs_val if op == "=" else self.apply_binop(
                op[:-1], self.lookup(name), rhs_val))
            self.updates[name] = str(value)
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
            _, op, name = node
            value = _wrap(self.lookup(name) + (1 if op == "++" else -1))
            self.updates[name] = str(value)
            return value
        if kind == "post":
            _, op, name = node
            value = self.lookup(name)
            self.updates[name] = str(_wrap(value + (1 if op == "++" else -1)))
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


def evaluate_arith(expr: str,
                   env: Mapping[str, str],
                   depth: int = 0) -> tuple[int, dict[str, str]]:
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

    Args:
        expr (str): the expression text, already ``$``-expanded.
        env (Mapping[str, str]): variable environment for reads.
        depth (int): recursion depth for variable re-evaluation.

    Returns:
        tuple[int, dict[str, str]]: the value and the assignments made
        (name to decimal string), for the caller to apply to the session.

    Raises:
        ArithError: on syntax errors, division by zero, or a negative
            exponent, with a bash-style message.
    """
    tokens = _tokenize(expr)
    if not tokens:
        return 0, {}
    node = ArithParser(tokens).parse()
    updates: dict[str, str] = {}
    value = ArithEvaluator(env, updates, depth).run(node)
    return value, updates
