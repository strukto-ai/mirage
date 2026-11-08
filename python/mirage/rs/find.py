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
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, time, timedelta, timezone, tzinfo
from typing import Literal

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
from mirage.core.generic.types import (
    Access,
    Action,
    ActionKind,
    And,
    Count,
    Empty,
    Lname,
    Mtime,
    Name,
    NoOwner,
    Not,
    Or,
    Owner,
    Path,
    Perm,
    PredNode,
    Prune,
    Quit,
    Regex,
    RowActionKind,
    Size,
    TrueNode,
    Type,
    XType,
)
from mirage.rs.scan import scanned
from mirage.shell.bytes import text_view, utf8_locale
from mirage.types import JsonValue
from mirage.utils.clock import system_now
from mirage.utils.dates import parse_date_expr
from mirage.utils.timezone import zone_from_env

OPERAND = ""
DAY = 86400
MINUTE = 60


@dataclass
class FindExpr:
    """One parsed find expression: the predicate tree plus everything the
    flat window lifts out of it.

    The tests a backend can answer per entry stay in ``tree``; the windows
    (depth, size, mtime) and the actions are global to the expression,
    because a native find op evaluates the tree and the executor applies
    the actions to what came back. A time test also sits in the tree as an
    ``Mtime`` node: only one in the top-level ``-a`` chain narrows the
    time window, and the tree decides the rest per entry, as it decides
    where a ``-prune`` after one fires. ``newer`` holds ``-newer``
    reference operands as typed, which the executor resolves against the
    dispatcher before it binds the expression.

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
        follow (bool): ``-follow``, which follows links as ``-L`` does.
        files0_from (str | None): ``-files0-from``'s file as typed, which
            names the start points in place of the operands.
        files0_at (list[int]): where each ``-files0-from`` stands among
            the expression's words.
        reached (int | None): how many of the actions, in order, a row can
            reach: those before a top-level ``-quit``; None for all.
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
    follow: bool = False
    files0_from: str | None = None
    files0_at: list[int] = field(default_factory=list)
    reached: int | None = None
    predicates: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    start: int = 0

    @property
    def execs(self) -> list[ExecAction]:
        """The ``-exec`` actions, in order."""
        return [a for a in self.actions if isinstance(a, ExecAction)]

    @property
    def files(self) -> list[str]:
        """Every file ``-fprint``, ``-fprint0`` and ``-fprintf`` write,
        as typed, each once, in the order first named."""
        named = [
            a.file
            for a in self.actions
            if isinstance(a, (RowAction, PrintfAction)) and a.file is not None
        ]
        return list(dict.fromkeys(named))


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
    if value in ("Infinity", "-Infinity"):
        return float(value)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"find: mirage-rs answered {value!r}, not a number")
    return float(value)


def _flag(value: JsonValue) -> bool:
    if not isinstance(value, bool):
        raise TypeError(f"find: mirage-rs answered {value!r}, not a flag")
    return value


def _opt_int(value: JsonValue) -> int | None:
    return None if value is None else _int(value)


def _opt_text(value: JsonValue) -> str | None:
    return None if value is None else text_view(_str(value))


def _opt_bound(value: JsonValue) -> int | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError(f"find: mirage-rs answered {value!r}, not a bound")
    return int(value)


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


def _before(timestamp: float) -> float:
    return math.nextafter(timestamp, -math.inf)


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

    GNU drops the fraction of a file's age in days before comparing, so
    ``+N`` matches only files at least N+1 whole days old.

    Args:
        cmp (str): ``+``, ``-`` or ``=``.
        days (float): the day count.
        now (float): the clock the day count is measured from.
    """
    if cmp == "+":
        return None, now - (days + 1) * DAY
    if cmp == "-":
        return now - days * DAY, None
    return now - (days + 1) * DAY, now - days * DAY


def age_bounds(
    cmp: str, amount: float, minutes: bool, origin: float
) -> tuple[float | None, float | None]:
    """One age test (``-mtime``, ``-amin``...) as inclusive epoch-second
    bounds.

    A day count drops the fraction of the age (``mtime_bounds``); a
    minute count rounds it up, measured on findutils 4.10: ``-mmin N``
    holds for an age above N-1 minutes and at most N, ``+N`` for one
    above N and ``-N`` for one below.

    Args:
        cmp (str): ``+``, ``-`` or ``=``.
        amount (float): the count of days or minutes.
        minutes (bool): the count is minutes.
        origin (float): the time ages are measured back from.
    """
    if not minutes:
        return mtime_bounds(cmp, amount, origin)
    edge = origin - amount * MINUTE
    if cmp == "+":
        return None, _before(edge)
    if cmp == "-":
        return strictly_after(edge), None
    return edge, _before(edge + MINUTE)


def next_midnight(now: float, zone: tzinfo | None) -> float:
    """``-daystart``'s origin: the midnight that ends today.

    Args:
        now (float): the clock, epoch seconds.
        zone (tzinfo | None): the session's ``TZ``, None for the host's
            local zone.
    """
    here = (
        datetime.fromtimestamp(now, zone)
        if zone is not None
        else datetime.fromtimestamp(now).astimezone()
    )
    tomorrow = here.date() + timedelta(days=1)
    return datetime.combine(tomorrow, time(0), tzinfo=here.tzinfo).timestamp()


def _merge(
    window: tuple[float | None, float | None] | None,
    bounds: tuple[float | None, float | None],
) -> tuple[float | None, float | None]:
    """Intersect one top-level time test with the expression's window.

    Every test in the top-level ``-a`` chain must hold, so the windows
    intersect: ``-newer old -newer new`` keeps only what is newer than
    both, and ``-mtime +2 -mtime -1`` keeps nothing, as GNU answers. A
    test under ``-o`` or ``!`` need not hold for a match, so it never
    reaches here; its ``Mtime`` node decides it per entry.

    Args:
        window (tuple[float | None, float | None] | None): the window so
            far, None before the first test.
        bounds (tuple[float | None, float | None]): this test's bounds.
    """
    if window is None:
        return bounds
    (old_lo, old_hi), (lo, hi) = window, bounds
    return (
        lo if old_lo is None else old_lo if lo is None else max(old_lo, lo),
        hi if old_hi is None else old_hi if hi is None else min(old_hi, hi),
    )


def _action(raw: dict[str, JsonValue]) -> FindAction:
    kind = _str(raw["kind"])
    if kind == "exec":
        return ExecAction(
            argv=tuple(text_view(_str(w)) for w in _array(raw["argv"])),
            batch=_flag(raw["batch"]),
            in_dir=_flag(raw["dir"]),
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
            file=_opt_text(raw["file"]),
        )
    row: RowActionKind = _row_kind(kind)
    return RowAction(row, file=_opt_text(raw["file"]))


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
    zone: tzinfo | None = None
    utf8: bool = False
    profile: str | None = None
    window: tuple[float | None, float | None] | None = None


def _node(
    raw: dict[str, JsonValue], binding: _Binding, top: bool = True
) -> PredNode:
    op = _str(raw["op"])
    if op == "name":
        return Name(text_view(_str(raw["pattern"])), _flag(raw["icase"]))
    if op == "path":
        return Path(text_view(_str(raw["pattern"])), icase=_flag(raw["icase"]))
    if op == "regex":
        return Regex(
            text_view(_str(raw["pattern"])),
            icase=_flag(raw["icase"]),
            dialect=_dialect(_str(raw["dialect"])),
            extended=_flag(raw["extended"]),
            utf8=binding.utf8,
        )
    if op == "lname":
        return Lname(text_view(_str(raw["pattern"])), _flag(raw["icase"]))
    if op == "type":
        return Type(_str(raw["kind"]))
    if op == "xtype":
        return XType(_str(raw["kind"]))
    if op == "perm":
        return Perm(_int(raw["mode"]), _perm_bits(_str(raw["bits"])))
    if op == "count":
        return Count(
            _count_field(_str(raw["field"])),
            _cmp(_str(raw["cmp"])),
            _int(raw["count"]),
        )
    if op == "owner":
        return Owner(
            text_view(_str(raw["name"])),
            group=_flag(raw["group"]),
            profile=binding.profile,
        )
    if op == "nouser":
        return NoOwner(group=_flag(raw["group"]))
    if op == "access":
        return Access(_access_mode(_str(raw["mode"])))
    if op == "size":
        return Size(_opt_bound(raw["min"]), _opt_bound(raw["max"]))
    if op == "empty":
        return Empty()
    if op == "true":
        return TrueNode()
    if op == "prune":
        return Prune()
    if op == "quit":
        return Quit()
    if op == "not":
        return Not(_node(_object(raw["kid"]), binding, False))
    if op in ("and", "or"):
        # Only a test every match must pass is in the top-level -a chain.
        top = top and op == "and"
        kids = [
            _node(_object(kid), binding, top) for kid in _array(raw["kids"])
        ]
        return And(kids) if op == "and" else Or(kids)
    if op == "action":
        return Action(_action_kind(_str(raw["kind"])), _flag(raw["batch"]))
    return _time_node(op, raw, binding, top)


def _perm_bits(bits: str) -> Literal["exact", "all", "any"]:
    if bits == "exact":
        return "exact"
    if bits == "all":
        return "all"
    if bits == "any":
        return "any"
    raise TypeError(f"find: mirage-rs answered the -perm kind {bits!r}")


def _count_field(name: str) -> Literal["links", "uid", "gid"]:
    if name == "links":
        return "links"
    if name == "uid":
        return "uid"
    if name == "gid":
        return "gid"
    raise TypeError(f"find: mirage-rs answered the count {name!r}")


def _cmp(cmp: str) -> Literal["+", "-", "="]:
    if cmp == "+":
        return "+"
    if cmp == "-":
        return "-"
    if cmp == "=":
        return "="
    raise TypeError(f"find: mirage-rs answered the comparison {cmp!r}")


def _access_mode(mode: str) -> Literal["r", "w", "x"]:
    if mode == "r":
        return "r"
    if mode == "w":
        return "w"
    if mode == "x":
        return "x"
    raise TypeError(f"find: mirage-rs answered the access {mode!r}")


def _dialect(name: str) -> Literal["emacs", "posix"]:
    if name == "emacs":
        return "emacs"
    if name == "posix":
        return "posix"
    raise TypeError(f"find: mirage-rs answered the dialect {name!r}")


def _stamp(field: str) -> Literal["m", "a", "c"]:
    if field == "m":
        return "m"
    if field == "a":
        return "a"
    if field == "c":
        return "c"
    raise TypeError(f"find: mirage-rs answered the stamp {field!r}")


def _time_node(
    op: str, raw: dict[str, JsonValue], binding: _Binding, top: bool
) -> PredNode:
    stamp: Literal["m", "a", "c"] = "m"
    if op == "age":
        stamp = _stamp(_str(raw["field"]))
        origin = (
            next_midnight(binding.now, binding.zone)
            if _flag(raw["daystart"])
            else binding.now
        )
        bounds = age_bounds(
            _str(raw["cmp"]),
            _float(raw["amount"]),
            _flag(raw["minutes"]),
            origin,
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
    # The flat window is the modification time's alone.
    if top and stamp == "m":
        binding.window = _merge(binding.window, bounds)
    return Mtime(*bounds, field=stamp)


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

    def date_refusal(self) -> tuple[int, UsageError] | None:
        """The first ``-newermt`` text that is no date, in expression order.

        GNU reads ``-newer`` and ``-newermt`` left to right, so the
        references typed before that date are statted first and their
        error, if any, is the one reported.

        Returns:
            How many ``-newer`` references precede the date, with GNU's
            refusal of it; None when every date reads.
        """
        for entry in _array(self.values["dates"]):
            date, before = _array(entry)
            try:
                parse_newermt(text_view(_str(date)))
            except UsageError as exc:
                return _int(before), exc
        return None

    def bind(
        self,
        newer_times: Sequence[float] = (),
        now: float | None = None,
        env: Mapping[str, str] | None = None,
        profile: str | None = None,
    ) -> FindExpr:
        """The expression with its time tests resolved.

        Args:
            newer_times (Sequence[float]): each ``-newer`` reference's
                mtime in epoch seconds, in order; empty leaves every
                ``-newer`` a test that always holds, as one the executor
                could not resolve.
            now (float | None): the clock ``-mtime`` counts from, the
                current time by default.
            env (Mapping[str, str] | None): the command's environment,
                whose ``TZ`` places ``-daystart``'s midnight and whose
                locale reads a ``-regex`` subject.
            profile (str | None): the session's name, the owner
                ``-user`` sees on an entry that reports none.

        Raises:
            UsageError: a ``-newermt`` text that is no date.
        """
        binding = _Binding(
            newer_times,
            system_now() if now is None else now,
            zone=zone_from_env(env),
            utf8=utf8_locale(env),
            profile=profile,
        )
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
            follow=_flag(self.values["follow"]),
            files0_from=_opt_text(self.values["files0_from"]),
            files0_at=[_int(at) for at in _array(self.values["files0_at"])],
            reached=_int(self.values["reached"]),
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
    "age_bounds",
    "find_layout",
    "mtime_bounds",
    "next_midnight",
    "parse_find",
    "parse_find_expression",
    "parse_newermt",
    "strictly_after",
]
