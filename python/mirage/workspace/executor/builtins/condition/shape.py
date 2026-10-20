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

from collections.abc import Iterator, Sequence

from mirage.workspace.executor.builtins.condition.constants import (
    BINARY_OPS,
    UNARY_OPS,
)
from mirage.workspace.executor.builtins.condition.types import (
    FlatAnd,
    FlatBinary,
    FlatFail,
    FlatNode,
    FlatNot,
    FlatOr,
    FlatString,
    FlatUnary,
)


def flat_shape(name: str, words: Sequence[str]) -> FlatNode:
    """test's own reading of its words, by bash's arity rules: which
    words each operator takes, and where a grammar error stands.

    The evaluator runs this reading and the gate reads a test's file
    operands off it (``file_operands``), so both give each word the one
    role test gives it: in ``test -e -o yes`` the ``-o`` joins two
    strings, and only the word after a file operator it takes is a file.

    Args:
        name (str): the test's name, for its diagnostics.
        words (Sequence[str]): its words, brackets excluded.
    """
    n = len(words)
    if n == 0:
        return None
    if n == 1:
        return FlatString(0)
    if n == 2:
        return _two(name, words, 0)
    if n == 3:
        return _three(name, words, 0)
    if n == 4:
        return _four(name, words)
    return _Shape(name, words).run()


def flat_leaves(node: FlatNode) -> Iterator[FlatUnary | FlatBinary]:
    """The operator tests of a reading, in the order they are reached.

    Args:
        node (FlatNode): from ``flat_shape``.
    """
    if isinstance(node, (FlatUnary, FlatBinary)):
        yield node
    elif isinstance(node, FlatNot):
        yield from flat_leaves(node.inner)
    elif isinstance(node, (FlatAnd, FlatOr)):
        yield from flat_leaves(node.left)
        yield from flat_leaves(node.right)


def _two(name: str, words: Sequence[str], at: int) -> FlatNode:
    """Two-argument rule: ``!`` or a unary operator.

    Args:
        name (str): the test's name.
        words (Sequence[str]): its words.
        at (int): where the two begin.
    """
    first = words[at]
    if first == "!":
        return FlatNot(FlatString(at + 1))
    if first in UNARY_OPS:
        return FlatUnary(first, at + 1)
    return FlatFail(f"{name}: {first}: unary operator expected")


def _three(name: str, words: Sequence[str], at: int) -> FlatNode:
    """Three-argument rule: binary op, ``-a``/``-o``, ``!``, or parens.

    Args:
        name (str): the test's name.
        words (Sequence[str]): its words.
        at (int): where the three begin.
    """
    mid = words[at + 1]
    if mid == "-a":
        return FlatAnd(FlatString(at), FlatString(at + 2))
    if mid == "-o":
        return FlatOr(FlatString(at), FlatString(at + 2))
    if mid in BINARY_OPS:
        return FlatBinary(at, mid, at + 2)
    first = words[at]
    if first == "!":
        return FlatNot(_two(name, words, at + 1))
    if first == "(" and words[at + 2] == ")":
        return FlatString(at + 1)
    return FlatFail(f"{name}: {mid}: binary operator expected")


def _four(name: str, words: Sequence[str]) -> FlatNode:
    """Four-argument rule: leading ``!`` or parens, else expr parser.

    Args:
        name (str): the test's name.
        words (Sequence[str]): exactly four words.
    """
    if words[0] == "!":
        return FlatNot(_three(name, words, 1))
    if words[0] == "(" and words[3] == ")":
        return _two(name, words, 1)
    return _Shape(name, words).run()


class _Shape:
    """Recursive-descent ``test`` expression parser (>4 args, GNU expr
    grammar: or -> and -> term with ``!`` and parentheses). A grammar
    error ends the reading where it stands, after the terms before it,
    which test evaluates before it meets the error."""

    def __init__(self, name: str, words: Sequence[str]) -> None:
        self.name = name
        self.words = words
        self.pos = 0
        self.failed = False

    def _peek(self, offset: int = 0) -> str | None:
        i = self.pos + offset
        return self.words[i] if i < len(self.words) else None

    def _fail(self, message: str) -> FlatFail:
        self.failed = True
        return FlatFail(f"{self.name}: {message}")

    def run(self) -> FlatNode:
        node = self._or_expr()
        if not self.failed and self.pos != len(self.words):
            return FlatAnd(node, self._fail("too many arguments"))
        return node

    def _or_expr(self) -> FlatNode:
        node = self._and_expr()
        while not self.failed and self._peek() == "-o":
            self.pos += 1
            node = FlatOr(node, self._and_expr())
        return node

    def _and_expr(self) -> FlatNode:
        node = self._term()
        while not self.failed and self._peek() == "-a":
            self.pos += 1
            node = FlatAnd(node, self._term())
        return node

    def _term(self) -> FlatNode:
        tok = self._peek()
        if tok is None:
            return self._fail("argument expected")
        if tok == "!":
            self.pos += 1
            return FlatNot(self._term())
        if tok == "(":
            self.pos += 1
            inner = self._or_expr()
            if self.failed:
                return inner
            if self._peek() != ")":
                return FlatAnd(inner, self._fail("`)' expected"))
            self.pos += 1
            return inner
        nxt = self._peek(1)
        if nxt in BINARY_OPS and self._peek(2) is not None:
            binary = FlatBinary(self.pos, nxt, self.pos + 2)
            self.pos += 3
            return binary
        if tok in UNARY_OPS and nxt is not None and nxt not in ("-a", "-o"):
            unary = FlatUnary(tok, self.pos + 1)
            self.pos += 2
            return unary
        self.pos += 1
        return FlatString(self.pos - 1)
