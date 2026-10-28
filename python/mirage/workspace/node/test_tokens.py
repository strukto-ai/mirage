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

from dataclasses import dataclass
from typing import Any

from mirage.shell.helpers import get_text
from mirage.shell.types import NodeType as NT
from mirage.shell.types import TSNodeLike

_CONTAINER_TYPES = (
    NT.BINARY_EXPRESSION,
    NT.UNARY_EXPRESSION,
    NT.NEGATION_EXPRESSION,
    NT.PARENTHESIZED_EXPRESSION,
)
# A comparison's right side is a pattern the run renders in its matcher's
# dialect (quoted segments escaped, `=~`'s quotes kept apart), never the
# word a reader of the line holds.
PATTERN_OPS = frozenset({"=", "==", "!=", "=~"})


# One token of a ``[[ ]]`` expression: an operator's text, or an operand
# node.
@dataclass(frozen=True, slots=True)
class ExprToken:
    op: str | None = None
    operand: Any = None


# A parsed ``[[ ]]`` expression: its kind, then its parts.
CondTree = tuple[Any, ...]


class CondSyntax(Exception):
    """The tokens are no expression the ``[[ ]]`` grammar reads."""


def cond_tokens(node: TSNodeLike) -> list[ExprToken]:
    """The tokens of a ``[[ ]]`` node in source order, which its grammar
    (``CondParser``) reads: every reader of the test reads these. The
    parser splits the test into bash's words and operators, a ``-x`` an
    operator only where bash reads one.

    Args:
        node (TSNodeLike): the test_command node opened with ``[[``.
    """
    out: list[ExprToken] = []
    _cond_into(node, out)
    return out


def _cond_into(node: TSNodeLike, out: list[ExprToken]) -> None:
    """Append the tokens of a ``[[ ]]`` node to ``out`` in source order.

    Args:
        node (TSNodeLike): parsed node to flatten.
        out (list[ExprToken]): accumulator.
    """
    for child in node.children:
        ctype = child.type
        if ctype in ("[[", "]]", NT.COMMENT):
            continue
        if not child.is_named and ctype != "$":
            out.append(ExprToken(op=ctype))
        elif ctype == NT.TEST_OPERATOR:
            out.append(ExprToken(op=get_text(child)))
        elif ctype in _CONTAINER_TYPES:
            _cond_into(child, out)
        else:
            # A lone `$` is the parser's anonymous token, and a word.
            out.append(ExprToken(operand=child))


class CondParser:
    """bash's ``[[ ]]`` grammar over the flat tokens, loosest first:
    ``||``, ``&&``, then a term. A term is any run of ``!`` (each one
    toggles a single inversion, so ``! !`` inverts nothing) before a
    parenthesized expression, a unary test, a binary test or a word.
    The tree is tuples whose leaves hold their operand nodes, expanded
    later by ``_cond_node``.
    """

    def __init__(self, tokens: list[ExprToken]) -> None:
        self.tokens = tokens
        self.at = 0

    def _op(self, ahead: int = 0) -> str | None:
        at = self.at + ahead
        return self.tokens[at].op if at < len(self.tokens) else None

    def _operand(self, ahead: int = 0) -> bool:
        at = self.at + ahead
        return at < len(self.tokens) and self.tokens[at].op is None

    def parse(self) -> CondTree:
        tree = self._either()
        if self.at != len(self.tokens):
            raise CondSyntax
        return tree

    def _either(self) -> CondTree:
        tree = self._both()
        while self._op() == "||":
            self.at += 1
            tree = ("or", tree, self._both())
        return tree

    def _both(self) -> CondTree:
        tree = self._term()
        while self._op() == "&&":
            self.at += 1
            tree = ("and", tree, self._term())
        return tree

    def _term(self) -> CondTree:
        inverted = False
        while self._op() == "!":
            self.at += 1
            inverted = not inverted
        if self._op() == "(":
            self.at += 1
            tree: CondTree = ("group", self._either())
            if self._op() != ")":
                raise CondSyntax
            self.at += 1
        else:
            tree = self._test()
        return ("not", tree) if inverted else tree

    def _test(self) -> CondTree:
        op = self._op()
        if op is not None and op.startswith("-") and self._operand(1):
            self.at += 2
            return ("unary", op, self.tokens[self.at - 1].operand)
        if not self._operand():
            raise CondSyntax
        left = self.tokens[self.at].operand
        op = self._op(1)
        if (
            op is not None
            and (op in COND_BINARY_TOKENS or op.startswith("-"))
            and self._operand(2)
        ):
            self.at += 3
            return ("binary", op, left, self.tokens[self.at - 1].operand)
        self.at += 1
        return ("word", left)


COND_BINARY_TOKENS = frozenset({"=", "==", "!=", "=~", "<", ">"})


def cond_leaves(tree: CondTree) -> list[CondTree]:
    """The tests of a parsed ``[[ ]]`` expression in source order: its
    unary, binary and word leaves, each a test of its own.

    Args:
        tree (CondTree): from ``CondParser``.
    """
    if tree[0] in ("and", "or"):
        return cond_leaves(tree[1]) + cond_leaves(tree[2])
    if tree[0] in ("not", "group"):
        return cond_leaves(tree[1])
    return [tree]
