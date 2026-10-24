from collections.abc import Mapping
from dataclasses import dataclass, field

from mirage.commands.builtin.utils.operands import (
    merge_split_errors,
    reported_stream,
    split_readable,
)
from mirage.commands.builtin.utils.size_suffix import decimal_value
from mirage.commands.builtin.utils.stream import (
    resolve_source,
    stdin_stat,
    stdin_stream,
)
from mirage.commands.builtin.utils.strtol import bounded_decimal
from mirage.commands.config import Context
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource, IOResult
from mirage.rs.stream import run_stream
from mirage.types import JsonValue, PathSpec, PolymorphicReadFn, StatFn

# A tab stop's digits are ASCII only: GNU reports U+0663 and the other
# non-ASCII digits as invalid characters, which a unicode-aware test
# (python `str.isdigit`, a `\d` class) would accept.
_DIGITS = frozenset("0123456789")

# What may lead a number to make it a size rather than a stop.
_SPECIFIERS = frozenset("+/")

# GNU 9.7 refuses a tab stop at or past 2**63, quoting its digits as
# typed: `-t 9223372036854775807` is accepted and `-t 9223372036854775808`
# is "tab stop is too large '9223372036854775808'".
_TOO_LARGE = 2**63

# `isblank` in the C locale, which is space and TAB and nothing else. A
# newline, a carriage return, a vertical tab and a form feed are all
# invalid characters rather than separators.
_BLANKS = frozenset(" \t")


@dataclass(frozen=True, slots=True)
class TabStops:
    """One resolved ``-t``/``--tabs`` list.

    Three independent pieces, because ``-t 2,/4`` and ``-t 2,+4`` differ
    only in which of the last two is set. ``stops`` are the explicit
    columns in the order typed (validated ascending and non-zero);
    ``extend`` is ``/N``'s "round up to a multiple of N" beyond them and
    ``increment`` is ``+N``'s "add N to the last stop, repeatedly".
    All-empty means the default size 8.

    Args:
        stops (tuple[int, ...]): the explicit tab stop columns.
        extend (int): ``/N``'s multiple, 0 when unset.
        increment (int): ``+N``'s step, 0 when unset.
    """

    stops: tuple[int, ...] = ()
    extend: int = 0
    increment: int = 0


@dataclass(frozen=True, slots=True)
class ExpandFlags:
    tabs: TabStops = field(default_factory=TabStops)
    initial_only: bool = False


@dataclass(slots=True)
class _TabList:
    """The tab list as the ``-t`` values read so far have built it.

    The stops and the two sizes carry over from one ``-t`` to the next;
    what a single value is in the middle of does not (see
    `_read_tab_list`).

    Args:
        prog (str): the command the diagnostics name.
        stops (list[int]): the explicit stops, in typed order.
        extend (int): ``/N``'s size, 0 when unset.
        increment (int): ``+N``'s size, 0 when unset.
        problems (list[str]): the diagnostic lines so far.
    """

    prog: str
    stops: list[int] = field(default_factory=list)
    extend: int = 0
    increment: int = 0
    problems: list[str] = field(default_factory=list)


def _invalid(prog: str, rest: str) -> str:
    return (
        f"{prog}: tab size contains invalid character(s): '{quote_text(rest)}'"
    )


def _give_value(
    tabs: _TabList, value: int, waiting: list[str], given: str
) -> str | None:
    """Settle one number of a ``-t`` value, or refuse it for good.

    A number led by ``/`` or ``+`` (or by one still waiting from an
    earlier element of the same value, `-t 1,+0,3` making 3 the
    increment) sets that size; ``/`` wins over ``+`` when both lead it.
    A zero sets nothing and leaves the specifier waiting, so
    `-t +0,0,0` is the default 8. Measured on GNU 9.7:

    * a size set twice is refused, even by a zero: `-t +4 -t +0` is
      "'+' specifier only allowed with the last value";
    * the other size is refused only by a nonzero value: `-t +4 -t /0`
      is accepted and `-t +4 -t /3` is "'/' specifier is mutually
      exclusive with '+'", in either order;
    * a plain number after a size in the same value is refused, naming
      the specifier character typed last (`-t /+4,2` names `+`), while
      `-t +4 -t 2` is two values and accepted.

    Args:
        tabs (_TabList): the list being built.
        value (int): the number.
        waiting (list[str]): the specifier characters waiting for a
            value, emptied once one is set.
        given (str): the character that set a size earlier in this
            value, or empty.

    Returns:
        str | None: the character that set a size, or None when the
            number is refused (the line is in ``tabs.problems``).
    """
    if not waiting:
        if given:
            tabs.problems.append(
                f"{tabs.prog}: '{given}' specifier only allowed with the last"
                " value"
            )
            return None
        tabs.stops.append(value)
        return given
    size = "/" if "/" in waiting else "+"
    if (tabs.extend if size == "/" else tabs.increment) != 0:
        tabs.problems.append(
            f"{tabs.prog}: '{size}' specifier only allowed with the last value"
        )
        return None
    if not value:
        return given
    if (tabs.increment if size == "/" else tabs.extend) != 0:
        tabs.problems.append(
            f"{tabs.prog}: '/' specifier is mutually exclusive with '+'"
        )
        return None
    if size == "/":
        tabs.extend = value
    else:
        tabs.increment = value
    named = waiting[-1]
    waiting.clear()
    return named


def _read_number(
    raw: str, at: int, tabs: _TabList
) -> tuple[int, int | None, list[str]] | None:
    """One number of a ``-t`` value, from its first digit to its end.

    Args:
        raw (str): the value as typed.
        at (int): where the number's first digit is.
        tabs (_TabList): the list being built, for the diagnostics.

    Returns:
        tuple[int, int | None, list[str]] | None: where the number
            ends, its value (None when a digit run was too large) and
            the specifier characters misplaced inside it; None when an
            invalid character ended the parse.
    """
    digits = ""
    misplaced: list[str] = []
    oversized = False
    while at < len(raw) and raw[at] != "," and raw[at] not in _BLANKS:
        char = raw[at]
        if char in _SPECIFIERS:
            tabs.problems.append(
                f"{tabs.prog}: '{char}' specifier not at start of number:"
                f" '{quote_text(raw[at:])}'"
            )
            misplaced.append(char)
            at += 1
            continue
        if char not in _DIGITS:
            tabs.problems.append(_invalid(tabs.prog, raw[at:]))
            return None
        run = at
        while at < len(raw) and raw[at] in _DIGITS:
            at += 1
        if bounded_decimal(raw[run:at], _TOO_LARGE) is None:
            tabs.problems.append(
                f"{tabs.prog}: tab stop is too large"
                f" '{quote_text(raw[run:at])}'"
            )
            oversized = True
        digits += raw[run:at]
    return at, None if oversized else decimal_value(digits), misplaced


def _read_tab_list(raw: str, tabs: _TabList) -> bool:
    """Read one ``-t`` value into ``tabs``.

    Numbers are split by commas and blanks (`isblank` in C: space and
    TAB), and an empty element is skipped. A ``/`` or ``+`` after a
    number's first digit is reported with the rest of the value and
    the scan goes on (`-t 4+5+6` reports '+5+6' and then '+6'), the
    character then leading the next number instead, so `-t 4+5,6,7`
    goes on to refuse the 7 as GNU does. A digit run at or past 2**63
    is reported and the scan goes on too (`-t 99999999999999999999,x`
    reports both). Either leaves the list refused. Any other character
    ends the whole parse, quoting the rest of the value (`-t 1,x,0`
    reports 'x,0').

    Args:
        raw (str): the value as typed.
        tabs (_TabList): the list being built.

    Returns:
        bool: False when the parse ended here.
    """
    waiting: list[str] = []
    given = ""
    at = 0
    while at < len(raw):
        char = raw[at]
        if char == "," or char in _BLANKS:
            at += 1
            continue
        if char in _SPECIFIERS:
            waiting.append(char)
            at += 1
            continue
        if char not in _DIGITS:
            tabs.problems.append(_invalid(tabs.prog, raw[at:]))
            return False
        number = _read_number(raw, at, tabs)
        if number is None:
            return False
        at, value, misplaced = number
        if value is not None:
            named = _give_value(tabs, value, waiting, given)
            if named is None:
                return False
            given = named
        waiting.extend(misplaced)
    return True


def _refused_order(prog: str, stops: list[int]) -> str | None:
    """GNU's walk over the explicit stops, once every value has scanned.

    Each stop is tested for zero before it is tested against the one
    before it, so `-t 3,0` cannot be 0 and `-t 3,1,0` must be
    ascending.

    Args:
        prog (str): the command the diagnostic names.
        stops (list[int]): the stops in typed order.

    Returns:
        str | None: the one diagnostic line, or None when they pass.
    """
    previous = 0
    for stop in stops:
        if stop == 0:
            return f"{prog}: tab size cannot be 0"
        if stop <= previous:
            return f"{prog}: tab sizes must be ascending"
        previous = stop
    return None


def read_tab_stops(occurrences: list[str], prog: str = "expand") -> TabStops:
    """Every ``-t``/``--tabs`` value one line carried, as one tab list.

    GNU takes a LIST of tab stops, not a single size, and ``-t``
    accumulates across occurrences, so this is handed every occurrence
    in typed order rather than the one value the flag bag kept. A value
    that leaves any problem ends the parse there: `-t 4+ -t x` reports
    only the '+'.

    unexpand reads its list the same way, in its own name.

    Args:
        occurrences (list[str]): the raw values, in typed order.
        prog (str): the command the diagnostics name.

    Returns:
        TabStops: the resolved stops, all-empty for the default 8.

    Raises:
        ValueError: the stderr text to print, newline-separated with no
            trailing newline, exit 1.
    """
    tabs = _TabList(prog)
    for raw in occurrences:
        if not _read_tab_list(raw, tabs) or tabs.problems:
            raise ValueError("\n".join(tabs.problems))
    refused = _refused_order(prog, tabs.stops)
    if refused is not None:
        raise ValueError(refused)
    return TabStops(tuple(tabs.stops), tabs.extend, tabs.increment)


def parse_flags(flags: Mapping[str, FlagValue]) -> ExpandFlags:
    """Read expand's flags once, refusing a tab list GNU refuses.

    ``-t`` accumulates across occurrences, so it is declared
    ``multiple`` and read as the list it typed.

    Args:
        flags (Mapping[str, FlagValue]): the dispatcher's flag bag.

    Raises:
        ValueError: the stderr text to print, exit 1.
    """
    fl = FlagView(flags, spec=SPECS["expand"])
    return ExpandFlags(
        tabs=read_tab_stops(fl.as_list("tabs")),
        initial_only=fl.as_bool("initial"),
    )


def tab_config(tabs: TabStops) -> dict[str, JsonValue]:
    """The tab list as the expand and unexpand streams take it.

    Args:
        tabs (TabStops): the resolved tab list.
    """
    return {
        "stops": list(tabs.stops),
        "extend": tabs.extend,
        "increment": tabs.increment,
    }


async def expand_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run expand over resolved operands; mirrors expandGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by expand.
        ctx (Context): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    stat = stdin_stat(stat)
    try:
        parsed = parse_flags(ctx.flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=f"{exc}\n".encode())
    readable, err = await split_readable(paths, stat, "expand")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    io = IOResult()
    read = stdin_stream(stream, ctx.stdin)
    sources = [reported_stream(read(p), io, p, "expand") for p in readable]
    source = async_chain(sources) if readable else resolve_source(ctx.stdin)
    config: dict[str, JsonValue] = {
        "tabs": tab_config(parsed.tabs),
        "initial_only": parsed.initial_only,
    }
    output = run_stream("expand", config, source)
    return await merge_split_errors((output, io), err)


__all__ = [
    "ExpandFlags",
    "TabStops",
    "expand_generic",
    "parse_flags",
    "read_tab_stops",
    "tab_config",
]
