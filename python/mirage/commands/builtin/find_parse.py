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

from dataclasses import dataclass, field

from mirage.commands.builtin.find_eval import (And, Empty, Name, Not, Or, Path,
                                               PredNode, TrueNode, Type)
from mirage.commands.builtin.find_helper import _parse_mtime, _parse_size
from mirage.commands.errors import FindParseError

_VALUE_PREDICATES = frozenset({
    "-name",
    "-iname",
    "-path",
    "-type",
    "-size",
    "-mtime",
    "-maxdepth",
    "-mindepth",
})

_BARE_PREDICATES = frozenset({
    "-empty",
    "-print",
    "-print0",
    "-delete",
    "-ls",
    "-depth",
})

_OPERATORS = frozenset({
    "-not",
    "!",
    "-o",
    "-or",
    "-a",
    "-and",
    "(",
    ")",
})

_EXPRESSION_TOKENS = _VALUE_PREDICATES | _BARE_PREDICATES | _OPERATORS

_VALID_TYPES = frozenset({"b", "c", "d", "p", "f", "l", "s"})

_MAX_DEPTH = 100


@dataclass
class FindExpr:
    tree: PredNode
    maxdepth: int | None = None
    mindepth: int | None = None
    min_size: int | None = None
    max_size: int | None = None
    mtime_min: float | None = None
    mtime_max: float | None = None
    uses_empty: bool = False


@dataclass
class _State:
    tokens: list[str]
    pos: int = 0
    depth: int = 0
    mtime_seen: bool = False
    expr: FindExpr = field(default_factory=lambda: FindExpr(tree=TrueNode()))


def _peek(state: _State) -> str | None:
    return state.tokens[state.pos] if state.pos < len(state.tokens) else None


def _advance(state: _State) -> str | None:
    tok = _peek(state)
    if tok is not None:
        state.pos += 1
    return tok


def _type_node(value: str) -> Type:
    if value in ("f", "file"):
        return Type("f")
    if value in ("d", "directory"):
        return Type("d")
    if value in _VALID_TYPES:
        return Type(value)
    raise FindParseError(f"find: Unknown argument to -type: {value}")


def _int_arg(value: str, flag: str) -> int:
    try:
        return int(value)
    except ValueError as exc:
        raise FindParseError(
            f"find: invalid argument '{value}' to '{flag}'") from exc


def _size_arg(value: str) -> tuple[int | None, int | None]:
    try:
        return _parse_size(value)
    except (ValueError, IndexError) as exc:
        raise FindParseError(
            f"find: invalid argument '{value}' to '-size'") from exc


def _mtime_arg(value: str) -> tuple[float | None, float | None]:
    try:
        return _parse_mtime(value)
    except (ValueError, IndexError) as exc:
        raise FindParseError(
            f"find: invalid argument '{value}' to '-mtime'") from exc


def _parse_primary(state: _State) -> PredNode:
    tok = _advance(state)
    if tok is None:
        raise FindParseError("find: expected predicate")
    if tok in _VALUE_PREDICATES:
        value = _advance(state)
        if value is None:
            raise FindParseError(f"find: missing argument to '{tok}'")
        if tok == "-name":
            return Name(value)
        if tok == "-iname":
            return Name(value, icase=True)
        if tok == "-path":
            return Path(value)
        if tok == "-type":
            return _type_node(value)
        if tok == "-maxdepth":
            state.expr.maxdepth = _int_arg(value, "-maxdepth")
            return TrueNode()
        if tok == "-mindepth":
            state.expr.mindepth = _int_arg(value, "-mindepth")
            return TrueNode()
        if tok == "-size":
            state.expr.min_size, state.expr.max_size = _size_arg(value)
            return TrueNode()
        # The flat window cannot evaluate -mtime per predicate node, so
        # repeated -mtime flatten to the union of their windows: the
        # tautology `-mtime +0 -o -mtime -1` imposes no bounds instead
        # of last-wins dropping everything. An AND of disjoint windows
        # over-matches (documented divergence from GNU).
        mt_lo, mt_hi = _mtime_arg(value)
        if not state.mtime_seen:
            state.expr.mtime_min, state.expr.mtime_max = mt_lo, mt_hi
            state.mtime_seen = True
        else:
            state.expr.mtime_min = (None if state.expr.mtime_min is None
                                    or mt_lo is None else min(
                                        state.expr.mtime_min, mt_lo))
            state.expr.mtime_max = (None if state.expr.mtime_max is None
                                    or mt_hi is None else max(
                                        state.expr.mtime_max, mt_hi))
        return TrueNode()
    if tok == "-empty":
        state.expr.uses_empty = True
        return Empty()
    if tok in _BARE_PREDICATES:
        return TrueNode()
    raise FindParseError(f"find: unknown predicate '{tok}'")


def _parse_factor(state: _State) -> PredNode:
    state.depth += 1
    if state.depth > _MAX_DEPTH:
        raise FindParseError("find: expression too deeply nested")
    try:
        tok = _peek(state)
        if tok in ("-not", "!"):
            _advance(state)
            return Not(_parse_factor(state))
        if tok == "(":
            _advance(state)
            node = _parse_or(state)
            if _peek(state) != ")":
                raise FindParseError("find: unbalanced parentheses")
            _advance(state)
            return node
        return _parse_primary(state)
    finally:
        state.depth -= 1


def _parse_and(state: _State) -> PredNode:
    factors = [_parse_factor(state)]
    while True:
        tok = _peek(state)
        if tok in ("-a", "-and"):
            _advance(state)
            factors.append(_parse_factor(state))
            continue
        if tok is None or tok in ("-o", "-or", ")"):
            break
        factors.append(_parse_factor(state))
    return factors[0] if len(factors) == 1 else And(factors)


def _parse_or(state: _State) -> PredNode:
    terms = [_parse_and(state)]
    while _peek(state) in ("-o", "-or"):
        _advance(state)
        terms.append(_parse_and(state))
    return terms[0] if len(terms) == 1 else Or(terms)


def find_expr_tail(raw_argv: list[str]) -> list[str]:
    for i, tok in enumerate(raw_argv):
        if tok in _EXPRESSION_TOKENS or (tok.startswith("-") and len(tok) > 1):
            return raw_argv[i:]
    return []


def parse_find_expression(tokens: list[str]) -> FindExpr:
    if not tokens:
        return FindExpr(tree=TrueNode())
    state = _State(tokens=tokens)
    tree = _parse_or(state)
    if _peek(state) is not None:
        raise FindParseError(f"find: unexpected token '{_peek(state)}'")
    state.expr.tree = tree
    return state.expr
