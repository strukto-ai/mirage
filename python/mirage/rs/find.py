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
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import timezone

from mirage.commands.builtin.types import (
    ExecAction,
    FindAction,
    PrintfAction,
    PrintfDirective,
    PrintfLiteral,
    PrintfPart,
    PrintfTime,
    RowAction,
)
from mirage.commands.errors import UsageError
from mirage.core.generic.find_eval import (
    Action,
    ActionKind,
    And,
    Empty,
    Mtime,
    Name,
    Not,
    Or,
    Path,
    PredNode,
    Prune,
    RowActionKind,
    TrueNode,
    Type,
)
from mirage.rs.scan import scanned
from mirage.shell.bytes import text_view
from mirage.types import JsonValue
from mirage.utils.dates import parse_date_expr

OPERAND = ""
DAY = 86400


@dataclass
class FindExpr:
    """One parsed find expression: the predicate tree plus everything the
    flat window lifts out of it.

    The tests a backend can answer per entry stay in ``tree``; the windows
    (depth, size, mtime) and the actions are global to the expression,
    because a native find op evaluates the tree and the executor applies
    the actions to what came back. A time test also sits in the tree as an
    ``Mtime`` node, for its position alone: a ``-prune`` after it fires
    only where the test holds. ``newer`` holds ``-newer`` reference
    operands as typed, which the executor resolves against the dispatcher
    before it binds the expression.

    Args:
        tree (PredNode): the predicate tree.
        maxdepth (int | None): ``-maxdepth``.
        mindepth (int | None): ``-mindepth``.
        min_size (int | None): the size window's inclusive lower bound.
        max_size (int | None): the size window's inclusive upper bound.
        mtime_min (float | None): the time window's inclusive lower bound.
        mtime_max (float | None): the time window's inclusive upper bound.
        uses_empty (bool): the expression holds ``-empty``.
        actions (list[FindAction]): in the order written, since GNU runs
            actions per position.
        newer (list[str]): the ``-newer`` references as typed.
        depth_first (bool): GNU's ``-depth``, which ``-delete`` turns on.
        predicates (list[str]): every predicate word typed, in order.
        warnings (list[str]): the warning lines GNU prints while it
            parses, in order.
        start (int): where the expression begins among the words typed.
    """

    tree: PredNode = field(default_factory=TrueNode)
    maxdepth: int | None = None
    mindepth: int | None = None
    min_size: int | None = None
    max_size: int | None = None
    mtime_min: float | None = None
    mtime_max: float | None = None
    uses_empty: bool = False
    actions: list[FindAction] = field(default_factory=list)
    newer: list[str] = field(default_factory=list)
    depth_first: bool = False
    predicates: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    start: int = 0

    @property
    def execs(self) -> list[ExecAction]:
        """The ``-exec`` actions, in order."""
        return [a for a in self.actions if isinstance(a, ExecAction)]


@dataclass(frozen=True, slots=True)
class FindLayout:
    """Where find's expression begins among the words typed, and which
    words an ``-exec`` owns.

    Args:
        start (int): the index of the expression's first word.
        spans (list[tuple[int, int]]): each ``-exec``'s inclusive word
            range, an unterminated one running to the end.
    """

    start: int
    spans: list[tuple[int, int]]


def _object(value: JsonValue) -> dict[str, JsonValue]:
    if not isinstance(value, dict):
        raise TypeError(f"find: mirage-rs answered {value!r}, not an object")
    return value


def _array(value: JsonValue) -> list[JsonValue]:
    if not isinstance(value, list):
        raise TypeError(f"find: mirage-rs answered {value!r}, not a list")
    return value


def _str(value: JsonValue) -> str:
    if not isinstance(value, str):
        raise TypeError(f"find: mirage-rs answered {value!r}, not text")
    return value


def _int(value: JsonValue) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"find: mirage-rs answered {value!r}, not a count")
    return value


def _float(value: JsonValue) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"find: mirage-rs answered {value!r}, not a number")
    return float(value)


def _flag(value: JsonValue) -> bool:
    if not isinstance(value, bool):
        raise TypeError(f"find: mirage-rs answered {value!r}, not a flag")
    return value


def _opt_int(value: JsonValue) -> int | None:
    return None if value is None else _int(value)


def _opt_bound(value: JsonValue) -> int | None:
    if value is None:
        return None
    if isinstance(value, float):
        return int(value)
    return _int(value)


def _words(argv: Sequence[str]) -> list[tuple[str, str]]:
    return [(OPERAND, word) for word in argv]


def find_layout(argv: Sequence[str]) -> FindLayout:
    """Where the expression begins in the words typed after ``find``, and
    which words an ``-exec`` owns, read by mirage-rs without parsing the
    expression, so a line that will be refused still classifies.

    Args:
        argv (Sequence[str]): the command's words, without the name.
    """
    values = scanned("find_layout", _words(argv))
    return FindLayout(
        start=_int(values["start"]),
        spans=[
            (_int(_array(span)[0]), _int(_array(span)[1]))
            for span in _array(values["spans"])
        ],
    )


def strictly_after(timestamp: float) -> float:
    """The inclusive lower bound that means "later than ``timestamp``".

    ``-newer`` and ``-newermt`` are strict (GNU: modified *more recently
    than*), and the window is inclusive, so the bound is the next
    representable float: exact, where adding an epsilon would either miss
    a timestamp or admit the reference itself.

    Args:
        timestamp (float): the reference time, epoch seconds.
    """
    return math.nextafter(timestamp, math.inf)


def parse_newermt(value: str) -> float:
    """One ``-newermt`` argument as the reference epoch time.

    Args:
        value (str): a GNU date expression, with naive times read as UTC.

    Raises:
        UsageError: GNU's refusal when the text is no date.
    """
    try:
        ts = parse_date_expr(value, tz=timezone.utc)
    except (ValueError, OverflowError, OSError):
        ts = None
    if ts is None:
        raise UsageError(
            "find: I cannot figure out how to interpret "
            f"'{value}' as a date or time",
            1,
        )
    return ts.timestamp()


def mtime_bounds(
    cmp: str, days: float, now: float
) -> tuple[float | None, float | None]:
    """One ``-mtime`` as inclusive epoch-second bounds.

    Args:
        cmp (str): ``+``, ``-`` or ``=``.
        days (float): the day count.
        now (float): the clock the day count is measured from.
    """
    if cmp == "+":
        return None, now - days * DAY
    if cmp == "-":
        return now - days * DAY, None
    return now - (days + 1) * DAY, now - days * DAY


def _merge(
    window: tuple[float | None, float | None] | None,
    bounds: tuple[float | None, float | None],
    fold: str,
) -> tuple[float | None, float | None]:
    """Fold one time test into the expression's single window.

    The flat window cannot evaluate a time test per predicate node, so
    repeated ones fold by where they sit. In the top-level ``-a`` chain
    every test must hold, so the windows intersect: ``-newer old -newer
    new`` keeps only what is newer than both, and ``-mtime +2 -mtime -1``
    keeps nothing, as GNU answers. Under ``-o``, ``!`` or parentheses the
    window cannot be exact, so they widen to the union: the tautology
    ``-mtime +0 -o -mtime -1`` imposes no bounds instead of last-wins
    dropping everything (documented divergence from GNU: such a window
    over-matches).

    Args:
        window (tuple[float | None, float | None] | None): the window so
            far, None before the first test.
        bounds (tuple[float | None, float | None]): this test's bounds.
        fold (str): ``all`` to intersect, ``any`` to widen.
    """
    if window is None:
        return bounds
    (old_lo, old_hi), (lo, hi) = window, bounds
    if fold == "all":
        return (
            lo
            if old_lo is None
            else old_lo
            if lo is None
            else max(old_lo, lo),
            hi
            if old_hi is None
            else old_hi
            if hi is None
            else min(old_hi, hi),
        )
    return (
        None if old_lo is None or lo is None else min(old_lo, lo),
        None if old_hi is None or hi is None else max(old_hi, hi),
    )


def _action(raw: dict[str, JsonValue]) -> FindAction:
    kind = _str(raw["kind"])
    if kind == "exec":
        return ExecAction(
            argv=tuple(text_view(_str(w)) for w in _array(raw["argv"])),
            batch=_flag(raw["batch"]),
        )
    if kind == "printf":
        parts: list[PrintfPart] = []
        for item in _array(raw["parts"]):
            part = _object(item)
            if "lit" in part:
                parts.append(PrintfLiteral(text_view(_str(part["lit"]))))
            elif "dir" in part:
                parts.append(PrintfDirective(_str(part["dir"])))
            else:
                parts.append(PrintfTime(_str(part["time"])))
        return PrintfAction(
            format=text_view(_str(raw["format"])),
            parts=tuple(parts),
            needs_stat=_flag(raw["stat"]),
        )
    row: RowActionKind = _row_kind(kind)
    return RowAction(row)


def _row_kind(kind: str) -> RowActionKind:
    if kind == "print":
        return "print"
    if kind == "print0":
        return "print0"
    if kind == "ls":
        return "ls"
    if kind == "delete":
        return "delete"
    raise TypeError(f"find: mirage-rs answered the action {kind!r}")


def _action_kind(kind: str) -> ActionKind:
    if kind == "exec":
        return "exec"
    if kind == "printf":
        return "printf"
    return _row_kind(kind)


@dataclass
class _Binding:
    refs: Sequence[float]
    now: float
    window: tuple[float | None, float | None] | None = None


def _node(raw: dict[str, JsonValue], binding: _Binding) -> PredNode:
    op = _str(raw["op"])
    if op == "name":
        return Name(text_view(_str(raw["pattern"])), _flag(raw["icase"]))
    if op == "path":
        return Path(text_view(_str(raw["pattern"])))
    if op == "type":
        return Type(_str(raw["kind"]))
    if op == "empty":
        return Empty()
    if op == "true":
        return TrueNode()
    if op == "prune":
        return Prune()
    if op == "not":
        return Not(_node(_object(raw["kid"]), binding))
    if op in ("and", "or"):
        kids = [_node(_object(kid), binding) for kid in _array(raw["kids"])]
        return And(kids) if op == "and" else Or(kids)
    if op == "action":
        return Action(_action_kind(_str(raw["kind"])), _flag(raw["batch"]))
    return _time_node(op, raw, binding)


def _time_node(
    op: str, raw: dict[str, JsonValue], binding: _Binding
) -> PredNode:
    fold = _str(raw["fold"])
    if op == "mtime":
        bounds = mtime_bounds(
            _str(raw["cmp"]), _float(raw["days"]), binding.now
        )
    elif op == "newermt":
        bounds = (
            strictly_after(parse_newermt(text_view(_str(raw["date"])))),
            None,
        )
    else:
        index = _int(raw["index"])
        if index >= len(binding.refs):
            return TrueNode()
        bounds = (strictly_after(binding.refs[index]), None)
    binding.window = _merge(binding.window, bounds, fold)
    return Mtime(*bounds)


@dataclass(frozen=True, slots=True)
class FindParse:
    """What mirage-rs read of a find line, before any time test is
    resolved.

    Args:
        values (dict[str, JsonValue]): the grammar's answer.
    """

    values: dict[str, JsonValue]

    @property
    def start(self) -> int:
        """Where the expression begins among the words typed."""
        return _int(self.values["start"])

    @property
    def newer(self) -> list[str]:
        """The ``-newer`` references, as typed, in expression order."""
        return [text_view(_str(ref)) for ref in _array(self.values["newer"])]

    def bind(
        self, newer_times: Sequence[float] = (), now: float | None = None
    ) -> FindExpr:
        """The expression with its time tests resolved.

        Args:
            newer_times (Sequence[float]): each ``-newer`` reference's
                mtime in epoch seconds, in order; empty leaves every
                ``-newer`` a test that always holds, as one the executor
                could not resolve.
            now (float | None): the clock ``-mtime`` counts from, the
                current time by default.

        Raises:
            UsageError: a ``-newermt`` text that is no date.
        """
        binding = _Binding(newer_times, time.time() if now is None else now)
        tree = _node(_object(self.values["tree"]), binding)
        window = binding.window or (None, None)
        return FindExpr(
            tree=tree,
            maxdepth=_opt_int(self.values["maxdepth"]),
            mindepth=_opt_int(self.values["mindepth"]),
            min_size=_opt_bound(self.values["min_size"]),
            max_size=_opt_bound(self.values["max_size"]),
            mtime_min=window[0],
            mtime_max=window[1],
            uses_empty=_flag(self.values["uses_empty"]),
            actions=[
                _action(_object(a)) for a in _array(self.values["actions"])
            ],
            newer=self.newer,
            depth_first=_flag(self.values["depth_first"]),
            predicates=[
                text_view(_str(w)) for w in _array(self.values["predicates"])
            ],
            warnings=[
                text_view(_str(w)) for w in _array(self.values["warnings"])
            ],
            start=self.start,
        )


def parse_find(argv: Sequence[str]) -> FindParse:
    """find's words read once by mirage-rs: the start points end where the
    expression begins, and the expression becomes a tree.

    Args:
        argv (Sequence[str]): the command's words, without the name.

    Raises:
        UsageError: the first word the grammar refuses, in GNU's words
            and with its exit status.
    """
    return FindParse(scanned("find", _words(argv)))


def parse_find_expression(argv: Sequence[str]) -> FindExpr:
    """``parse_find`` and ``bind`` with no reference resolved, for a
    caller holding only the words.

    Args:
        argv (Sequence[str]): the command's words, without the name.
    """
    return parse_find(argv).bind()


__all__ = [
    "FindExpr",
    "FindLayout",
    "FindParse",
    "find_layout",
    "mtime_bounds",
    "parse_find",
    "parse_find_expression",
    "parse_newermt",
    "strictly_after",
]
