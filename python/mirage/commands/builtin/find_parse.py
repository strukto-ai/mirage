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

import math
import time
from dataclasses import dataclass, field

from mirage.commands.builtin import constants
from mirage.commands.builtin.find_eval import (And, Empty, Name, Not, Or, Path,
                                               PredNode, TrueNode, Type)
from mirage.commands.builtin.types import ExecAction, FindAction, RowAction
from mirage.commands.errors import FindParseError
from mirage.utils.dates import parse_date_expr


def parse_depth(value: str, flag: str) -> int:
    """One -maxdepth/-mindepth argument as an int, or GNU's refusal.

    Args:
        value (str): the argument as typed.
        flag (str): the flag it filled, for the error message.
    """
    try:
        return int(value)
    except ValueError:
        raise FindParseError(
            f"find: invalid argument '{value}' to '{flag}'") from None


def parse_size(spec: str) -> tuple[int | None, int | None]:
    """One -size argument as inclusive byte bounds.

    GNU rounds the file size up to whole units before comparing, and
    +N / -N are strict: +N keeps ceil(size/unit) > N, -N keeps
    ceil(size/unit) < N, N alone keeps ceil(size/unit) == N. Expressed
    as inclusive byte bounds: +N -> [N*unit + 1, inf), -N ->
    [0, (N-1)*unit], N -> [(N-1)*unit + 1, N*unit].

    Args:
        spec (str): the argument as typed.
    """
    suffixes = {"c": 1, "k": 1024, "M": 1024**2, "G": 1024**3}
    if spec.startswith(("+", "-")):
        raw = spec[1:]
    else:
        raw = spec
    digits = raw.rstrip("ckMG")
    if not digits:
        raise FindParseError(f"find: invalid argument '{spec}' to '-size'")
    mult = suffixes.get(raw[-1], 1)
    try:
        n = int(digits)
    except ValueError:
        raise FindParseError(
            f"find: invalid argument '{spec}' to '-size'") from None
    if spec.startswith("+"):
        return n * mult + 1, None
    if spec.startswith("-"):
        return None, (n - 1) * mult
    return (n - 1) * mult + 1, n * mult


def parse_mtime(spec: str) -> tuple[float | None, float | None]:
    """One -mtime argument as inclusive epoch-second bounds.

    Args:
        spec (str): the argument as typed.
    """
    now = time.time()
    day = 86400
    try:
        n = int(spec.lstrip("+-"))
    except ValueError:
        raise FindParseError(
            f"find: invalid argument '{spec}' to '-mtime'") from None
    if spec.startswith("+"):
        return None, now - n * day
    if spec.startswith("-"):
        return now - n * day, None
    return now - (n + 1) * day, now - n * day


@dataclass
class FindExpr:
    """One parsed find expression: the predicate tree plus everything
    the flat window lifts out of it.

    The tests that a backend can answer per entry stay in ``tree``; the
    windows (depth, size, mtime) and the actions are global to the
    expression, because a native find op evaluates the tree and the
    executor applies the actions to what came back. ``newer`` holds
    ``-newer`` reference operands as typed, for the executor to resolve
    against the dispatcher into ``-newermt`` bounds before any backend
    sees the expression.
    """
    tree: PredNode
    maxdepth: int | None = None
    mindepth: int | None = None
    min_size: int | None = None
    max_size: int | None = None
    mtime_min: float | None = None
    mtime_max: float | None = None
    uses_empty: bool = False
    printf: str | None = None
    # In the order written: GNU runs actions per position, so
    # `-exec echo {} ";" -print -exec echo again {} ";"` alternates the
    # three per match.
    actions: list[FindAction] = field(default_factory=list)
    newer: list[str] = field(default_factory=list)
    # GNU's -depth: every directory's contents come before the directory
    # itself. -delete turns it on, since a directory can only be removed
    # once what it holds is gone.
    depth_first: bool = False

    @property
    def execs(self) -> list[ExecAction]:
        """The ``-exec`` actions, in order."""
        return [a for a in self.actions if isinstance(a, ExecAction)]


@dataclass
class _State:
    tokens: list[str]
    pos: int = 0
    depth: int = 0
    # How many parentheses and negations enclose the current token, and
    # whether a top-level `-o` has been seen: an action under either
    # would need per-position evaluation the flat window cannot do.
    nested: int = 0
    in_or: bool = False
    mtime_seen: bool = False
    newer_token: str | None = None
    expr: FindExpr = field(default_factory=lambda: FindExpr(tree=TrueNode()))


def _merge_window(state: _State, lo: float | None, hi: float | None) -> None:
    """Fold one mtime window into the expression's single window.

    The flat window cannot evaluate a time test per predicate node, so
    repeated ones fold by where they sit. In the top-level ``-a`` chain
    every test must hold, so the windows intersect: ``-newer old -newer
    new`` keeps only what is newer than both, and ``-mtime +2 -mtime
    -1`` keeps nothing, as GNU answers. Under ``-o``, ``!`` or
    parentheses the window cannot be exact, so they widen to the union:
    the tautology ``-mtime +0 -o -mtime -1`` imposes no bounds instead
    of last-wins dropping everything (documented divergence from GNU:
    such a window over-matches).

    Args:
        state (_State): parser state carrying the expression.
        lo (float | None): inclusive lower bound, epoch seconds.
        hi (float | None): inclusive upper bound, epoch seconds.
    """
    if not state.mtime_seen:
        state.expr.mtime_min, state.expr.mtime_max = lo, hi
        state.mtime_seen = True
        return
    if state.nested == 0 and not state.in_or:
        state.expr.mtime_min = (lo if state.expr.mtime_min is None else
                                state.expr.mtime_min if lo is None else max(
                                    state.expr.mtime_min, lo))
        state.expr.mtime_max = (hi if state.expr.mtime_max is None else
                                state.expr.mtime_max if hi is None else min(
                                    state.expr.mtime_max, hi))
        return
    state.expr.mtime_min = (None if state.expr.mtime_min is None or lo is None
                            else min(state.expr.mtime_min, lo))
    state.expr.mtime_max = (None if state.expr.mtime_max is None or hi is None
                            else max(state.expr.mtime_max, hi))


def strictly_after(timestamp: float) -> float:
    """The inclusive lower bound that means "later than ``timestamp``".

    ``-newer`` and ``-newermt`` are strict (GNU: modified *more recently
    than*), and the window is inclusive, so the bound is the next
    representable float: exact, where adding an epsilon would either
    miss a timestamp or admit the reference itself.

    Args:
        timestamp (float): the reference time, epoch seconds.
    """
    return math.nextafter(timestamp, math.inf)


def parse_newermt(value: str) -> float:
    """One ``-newermt`` argument as the reference epoch time.

    Args:
        value (str): a GNU date expression, with naive times read as UTC.
    """
    try:
        ts = parse_date_expr(value, utc=True)
    except (ValueError, OverflowError, OSError):
        ts = None
    if ts is None:
        raise FindParseError("find: I cannot figure out how to interpret "
                             f"'{value}' as a date or time")
    return ts.timestamp()


def _parse_exec(state: _State) -> ExecAction:
    """The words after ``-exec`` up to ``;`` or a ``{} +``.

    GNU's rules, in GNU's words: no terminator is a missing argument, a
    ``+`` counts as the terminator only right after a word holding
    ``{}``, and the batched form allows exactly one ``{}`` and only by
    itself.

    Args:
        state (_State): parser state, positioned after ``-exec``.
    """
    argv: list[str] = []
    batch = False
    while True:
        tok = _advance(state)
        if tok is None:
            raise FindParseError("find: missing argument to `-exec'")
        if tok == constants.EXEC_END:
            break
        if (tok == constants.EXEC_BATCH_END and argv
                and constants.EXEC_PLACEHOLDER in argv[-1]):
            batch = True
            break
        argv.append(tok)
    if not argv:
        raise FindParseError("find: missing argument to `-exec'")
    if batch:
        for word in argv:
            if (constants.EXEC_PLACEHOLDER in word
                    and word != constants.EXEC_PLACEHOLDER):
                raise FindParseError(
                    "find: In '-exec ... {} +' the '{}' must appear by "
                    f"itself, but you specified '{word}'")
        if argv.count(constants.EXEC_PLACEHOLDER) > 1:
            raise FindParseError("find: Only one instance of {} is supported "
                                 "with -exec ... +")
    if state.nested > 0 or state.in_or:
        # The executor runs the action on the matches the tree produced,
        # which is an AND with every test; under `-o`, `!` or parentheses
        # GNU would run it per position, and silently running it on the
        # wrong set is worse than refusing.
        raise FindParseError(_EXEC_PLACEMENT)
    return ExecAction(argv=tuple(argv), batch=batch)


_EXEC_PLACEMENT = ("find: -exec is supported only in a top-level -a chain, "
                   "not under -o, ! or parentheses")


def _check_action_placement(state: _State, token: str) -> None:
    if state.nested > 0 or state.in_or:
        raise FindParseError(
            f"find: {token} is supported only in a top-level -a chain, "
            "not under -o, ! or parentheses")


def _peek(state: _State) -> str | None:
    return state.tokens[state.pos] if state.pos < len(state.tokens) else None


def _advance(state: _State) -> str | None:
    tok = _peek(state)
    if tok is not None:
        state.pos += 1
    return tok


def _after_operator(state: _State, op: str) -> None:
    """Refuse an operator the line left without a right-hand side.

    GNU words the empty slot two ways and both name the operator, which
    is why this runs where the operator was just consumed rather than in
    _parse_primary: by the time the recursion reaches a primary the token
    that needed an operand is gone.

    Args:
        state (_State): parser state, positioned after the operator.
        op (str): the operator as typed (`!`, `-not`, `-a`, `-o`, ...).
    """
    tok = _peek(state)
    if tok is None:
        raise FindParseError(f"find: expected an expression after '{op}'")
    if tok == ")":
        raise FindParseError(
            f"find: expected an expression between '{op}' and ')'")


def _type_node(value: str) -> Type:
    if value in ("f", "file"):
        return Type("f")
    if value in ("d", "directory"):
        return Type("d")
    if value in constants.FIND_VALID_TYPES:
        return Type(value)
    raise FindParseError(f"find: Unknown argument to -type: {value}")


def _size_arg(value: str) -> tuple[int | None, int | None]:
    try:
        return parse_size(value)
    except (ValueError, IndexError) as exc:
        raise FindParseError(
            f"find: invalid argument '{value}' to '-size'") from exc


def _mtime_arg(value: str) -> tuple[float | None, float | None]:
    try:
        return parse_mtime(value)
    except (ValueError, IndexError) as exc:
        raise FindParseError(
            f"find: invalid argument '{value}' to '-mtime'") from exc


def _parse_primary(state: _State) -> PredNode:
    tok = _advance(state)
    if tok is None:
        raise FindParseError("find: expected predicate")
    if ((state.expr.actions or state.expr.printf is not None)
            and (tok == "-empty" or tok in constants.FIND_VALUE_PREDICATES -
                 {"-printf", "-maxdepth", "-mindepth"})):
        raise FindParseError(
            f"find: {tok}: tests after actions are not supported")
    if tok in constants.FIND_VALUE_PREDICATES:
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
        if tok == "-printf":
            if state.expr.printf is not None:
                raise FindParseError(
                    "find: multiple -printf actions are not supported")
            _check_action_placement(state, tok)
            # An action, not a test: it always matches, replaces the
            # default -print rendering, and one format applies to every
            # row (GNU evaluates actions per expression position, which
            # the flat window cannot express; a single trailing -printf,
            # the way agents write it, renders identically).
            state.expr.printf = value
            return TrueNode()
        if tok == "-maxdepth":
            state.expr.maxdepth = parse_depth(value, "-maxdepth")
            return TrueNode()
        if tok == "-mindepth":
            state.expr.mindepth = parse_depth(value, "-mindepth")
            return TrueNode()
        if tok == "-size":
            state.expr.min_size, state.expr.max_size = _size_arg(value)
            return TrueNode()
        if tok in ("-newer", "-newermt"):
            _check_action_placement(state, tok)
            state.newer_token = tok
        if tok == "-newer":
            # Resolved by the executor (`find_refs.py`) into -newermt,
            # since only the dispatcher can stat the reference.
            state.expr.newer.append(value)
            return TrueNode()
        if tok == "-newermt":
            _merge_window(state, strictly_after(parse_newermt(value)), None)
            return TrueNode()
        mt_lo, mt_hi = _mtime_arg(value)
        _merge_window(state, mt_lo, mt_hi)
        return TrueNode()
    if tok in constants.FIND_EXEC_PREDICATES:
        state.expr.actions.append(_parse_exec(state))
        return TrueNode()
    if tok == "-empty":
        state.expr.uses_empty = True
        return Empty()
    if tok in constants.FIND_ROW_ACTIONS:
        _check_action_placement(state, tok)
        state.expr.actions.append(RowAction(constants.FIND_ROW_ACTIONS[tok]))
        if tok == "-delete":
            state.expr.depth_first = True
        return TrueNode()
    if tok == "-depth":
        state.expr.depth_first = True
        return TrueNode()
    if tok in constants.FIND_BARE_PREDICATES:
        return TrueNode()
    raise FindParseError(f"find: unknown predicate '{tok}'")


def _parse_factor(state: _State) -> PredNode:
    state.depth += 1
    if state.depth > constants.FIND_MAX_DEPTH:
        raise FindParseError("find: expression too deeply nested")
    try:
        tok = _peek(state)
        if tok is not None and tok in ("-not", "!"):
            _advance(state)
            _after_operator(state, tok)
            state.nested += 1
            try:
                return Not(_parse_factor(state))
            finally:
                state.nested -= 1
        if tok == "(":
            _advance(state)
            state.nested += 1
            try:
                node = _parse_or(state)
            finally:
                state.nested -= 1
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
        if tok is not None and tok in ("-a", "-and"):
            _advance(state)
            _after_operator(state, tok)
            factors.append(_parse_factor(state))
            continue
        if tok is None or tok in ("-o", "-or", ")"):
            break
        factors.append(_parse_factor(state))
    return factors[0] if len(factors) == 1 else And(factors)


def _parse_or(state: _State) -> PredNode:
    terms = [_parse_and(state)]
    while True:
        tok = _peek(state)
        if tok is None or tok not in ("-o", "-or"):
            break
        _advance(state)
        _after_operator(state, tok)
        if state.nested == 0:
            state.in_or = True
            if state.newer_token is not None:
                _check_action_placement(state, state.newer_token)
            # An action already parsed sits on the left of this `-o`,
            # which is the same detachment from the tree seen from the
            # other side: `-exec false {} ; -o -print` would run the
            # action and then print nothing.
            if state.expr.execs:
                raise FindParseError(_EXEC_PLACEMENT)
            if state.expr.actions:
                action = state.expr.actions[0]
                assert isinstance(action, RowAction)
                _check_action_placement(state, f"-{action.kind}")
            if state.expr.printf is not None:
                _check_action_placement(state, "-printf")
        terms.append(_parse_and(state))
    return terms[0] if len(terms) == 1 else Or(terms)


# GNU find's link-policy options are leading options, not predicates:
# they may only appear before the start points, and never take part in
# the expression. Without this the tail scan would treat `-L` as the
# start of the expression and swallow the paths after it.
_LINK_OPTIONS = frozenset({"-P", "-H", "-L"})


def find_expr_tail(raw_argv: list[str]) -> list[str]:
    start = 0
    while start < len(raw_argv) and raw_argv[start] in _LINK_OPTIONS:
        start += 1
    for i in range(start, len(raw_argv)):
        tok = raw_argv[i]
        if tok in constants.FIND_EXPRESSION_TOKENS or (tok.startswith("-")
                                                       and len(tok) > 1):
            return raw_argv[i:]
    return []


def exec_spans(argv: list[str]) -> list[tuple[int, int]]:
    """The argv index ranges, inclusive, that ``-exec`` owns.

    Every word from ``-exec`` to its terminator is the action's, never
    an operand of find's own: the classifier reads this so ``echo``,
    ``{}`` and ``;`` are not turned into start points. A span with no
    terminator runs to the end; the parser reports that one.

    Args:
        argv (list[str]): the command's words, without the name.
    """
    spans: list[tuple[int, int]] = []
    i = 0
    while i < len(argv):
        if argv[i] not in constants.FIND_EXEC_PREDICATES:
            i += 1
            continue
        start = i
        i += 1
        while i < len(argv):
            tok = argv[i]
            if tok == constants.EXEC_END or (
                    tok == constants.EXEC_BATCH_END and i > start + 1
                    and constants.EXEC_PLACEHOLDER in argv[i - 1]):
                break
            i += 1
        spans.append((start, min(i, len(argv) - 1)))
        i += 1
    return spans


def parse_find_expression(tokens: list[str]) -> FindExpr:
    if not tokens:
        return FindExpr(tree=TrueNode())
    state = _State(tokens=tokens)
    tree = _parse_or(state)
    if _peek(state) is not None:
        raise FindParseError(f"find: unexpected token '{_peek(state)}'")
    state.expr.tree = tree
    if state.expr.execs and state.expr.printf is not None:
        # -printf rows are rendered by the backend's generic before the
        # executor sees them, so there is no path left to hand -exec.
        raise FindParseError("find: -exec cannot be combined with -printf")
    if state.expr.actions and state.expr.printf is not None:
        raise FindParseError(
            "find: -printf cannot be combined with other actions")
    return state.expr
