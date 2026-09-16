from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field

from mirage.commands.builtin.utils.operands import (materialized_read,
                                                    merge_split_errors,
                                                    split_readable)
from mirage.commands.builtin.utils.stream import read_stdin_async
from mirage.commands.config import CommandOpts
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn

# GNU's scanner is `c_isdigit`, which is ASCII. A unicode-aware test
# (python `str.isdigit`, a `\d` class) accepts U+0663 and friends, which
# GNU reports as invalid characters.
_DIGITS = frozenset("0123456789")

# `isblank` in the C locale, which is space and TAB and nothing else. A
# newline, a carriage return, a vertical tab and a form feed are all
# invalid characters rather than separators.
_BLANKS = frozenset(" \t")

# The accumulator GNU overflows: a tab stop is read into `uintmax_t`.
_UINTMAX_MAX = 18446744073709551615

_DEFAULT_TAB_SIZE = 8


@dataclass(frozen=True, slots=True)
class TabStops:
    """One resolved ``-t``/``--tabs`` list, as gnulib models it.

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
class _TabAccumulator:
    """The state gnulib keeps ACROSS ``-t`` occurrences.

    ``-t 2,4 -t 6`` is byte-identical to ``-t 2,4,6`` and ``-t 6 -t 2,4``
    refuses as non-ascending, so the stop list and the two specifier
    sizes outlive one occurrence. What does NOT outlive it is the
    per-scan state (a pending value, having seen ``/`` or ``+``), which
    is why ``-t '+4,2'`` refuses but ``-t +4 -t 2`` does not.

    Args:
        stops (list[int]): explicit stops collected so far.
        extend (int): ``/N``'s multiple, 0 while unset.
        increment (int): ``+N``'s step, 0 while unset.
        problems (list[str]): stderr lines collected so far.
    """
    stops: list[int]
    extend: int
    increment: int
    problems: list[str]


def _flush_stop(acc: _TabAccumulator, value: int, saw_extend: bool,
                saw_increment: bool) -> None:
    """Commit one scanned number, as ``/``, ``+`` or an ordinary stop.

    ``/`` wins when both specifiers were seen, matching GNU's
    ``if (extend) ... else if (increment) ...``. Either setter refuses a
    SECOND non-zero value, which is how ``-t '+4,2'`` and
    ``-t +4 -t +5`` are reported: the value 0 leaves the specifier unset,
    so ``-t '+0,1'`` is accepted and means an increment of 1.

    Args:
        acc (_TabAccumulator): the cross-occurrence state to update.
        value (int): the scanned number.
        saw_extend (bool): a ``/`` preceded it in this occurrence.
        saw_increment (bool): a ``+`` preceded it in this occurrence.
    """
    if saw_extend:
        if acc.extend:
            acc.problems.append("expand: '/' specifier only allowed "
                                "with the last value")
        acc.extend = value
        return
    if saw_increment:
        if acc.increment:
            acc.problems.append("expand: '+' specifier only allowed "
                                "with the last value")
        acc.increment = value
        return
    acc.stops.append(value)


def _check_stops(stops: list[int]) -> None:
    """GNU's two post-scan refusals, in the order it applies them.

    The list is walked in order and each element is tested for zero
    BEFORE it is tested for ascending, which is the only thing that
    tells the two messages apart on a list that breaks both rules:
    ``-t 3,0`` is ``cannot be 0`` (element 0 is zero) while
    ``-t 3,1,0`` is ``must be ascending`` (element 1 fails first). Both
    run only when the scan reported nothing at all, so ``-t 0,x`` names
    the ``x`` and never the zero.

    Args:
        stops (list[int]): the accumulated stops, in typed order.

    Raises:
        ValueError: the single stderr line to print, exit 1.
    """
    previous = 0
    for stop in stops:
        if stop == 0:
            raise ValueError("expand: tab size cannot be 0")
        if stop <= previous:
            raise ValueError("expand: tab sizes must be ascending")
        previous = stop


def _scan_tab_stops(raw: str, acc: _TabAccumulator) -> None:
    """Scan one ``-t`` occurrence, gnulib's ``parse_tab_stops``.

    Character by character, because every one of GNU's messages quotes a
    position rather than the argument: an invalid character and a
    misplaced specifier both quote the remainder FROM that character
    (``-t 1,x`` reports ``'x'`` where ``-t x,1`` reports ``'x,1'``), and
    an overflowing number quotes its own digit run. An empty element is
    skipped in silence, which is why ``-t ''``, ``-t ','`` and
    ``-t '1,,3'`` are all accepted.

    ONE thing ends the scan and two do not. An invalid character breaks
    it where it stands, so nothing to its right is read and
    ``-t '1,x,0'`` reports only the ``x,0``. A misplaced ``/``/``+``
    does NOT: it is reported and the scan carries on, so ``-t 4+5+6``
    prints two misplaced lines and ``-t 4+x`` prints the misplaced one
    and then the invalid-character one. Neither does an overflowing
    digit run, so ``-t '99999999999999999999,x'`` reports both lines.
    Any of them makes the caller skip ``_check_stops``, which is why
    ``-t '1,99999999999999999999,0'`` never mentions the zero.

    Args:
        raw (str): one occurrence's raw value.
        acc (_TabAccumulator): the cross-occurrence state to update.
    """
    have = False
    value = 0
    digits_at = 0
    saw_extend = False
    saw_increment = False
    index = 0
    while index < len(raw):
        char = raw[index]
        if char in "/+":
            if have:
                # Reported and then CONTINUED, unlike an invalid
                # character: `-t 4+5+6` prints TWO misplaced-specifier
                # lines and `-t 4+x` prints the misplaced one and then
                # the invalid-character one. The specifier is not
                # recorded either, so the `4` in `-t '4+,x'` still
                # flushes as an ordinary stop.
                acc.problems.append(
                    f"expand: '{char}' specifier not at start of "
                    f"number: '{quote_text(raw[index:])}'")
            else:
                saw_extend = saw_extend or char == "/"
                saw_increment = saw_increment or char == "+"
        elif char in _DIGITS:
            if not have:
                value = 0
                have = True
                digits_at = index
            value = value * 10 + int(char)
            if value > _UINTMAX_MAX:
                end = index
                while end < len(raw) and raw[end] in _DIGITS:
                    end += 1
                acc.problems.append("expand: tab stop is too large "
                                    f"'{quote_text(raw[digits_at:end])}'")
                index = end - 1
        elif char == "," or char in _BLANKS:
            if have:
                _flush_stop(acc, value, saw_extend, saw_increment)
                have = False
        else:
            acc.problems.append("expand: tab size contains invalid "
                                f"character(s): '{quote_text(raw[index:])}'")
            return
        index += 1
    if have and not acc.problems:
        _flush_stop(acc, value, saw_extend, saw_increment)


def parse_tab_stops(occurrences: list[str]) -> TabStops:
    """Every ``-t``/``--tabs`` value one line carried, as one tab list.

    GNU takes a LIST of tab stops, not a single size, and ``-t``
    accumulates across occurrences, so this is handed every occurrence
    in typed order rather than the one value the flag bag kept.

    Args:
        occurrences (list[str]): the raw values, in typed order.

    Returns:
        TabStops: the resolved stops, all-empty for the default 8.

    Raises:
        ValueError: the stderr text to print, newline-separated with no
            trailing newline, exit 1.
    """
    acc = _TabAccumulator(stops=[], extend=0, increment=0, problems=[])
    for raw in occurrences:
        _scan_tab_stops(raw, acc)
    if acc.problems:
        raise ValueError("\n".join(acc.problems))
    _check_stops(acc.stops)
    return TabStops(tuple(acc.stops), acc.extend, acc.increment)


def parse_flags(flags: Mapping[str, FlagValue]) -> ExpandFlags:
    """Read expand's flags once, refusing a tab list GNU refuses.

    Args:
        flags (Mapping[str, FlagValue]): the dispatcher's flag bag.

    Raises:
        ValueError: the stderr text to print, exit 1.
    """
    fl = FlagView(flags, spec=SPECS["expand"])
    return ExpandFlags(
        tabs=parse_tab_stops([raw for _, raw in fl.value_occurrences("tabs")]),
        initial_only=fl.as_bool("initial"),
    )


def next_tab_stop(tabs: TabStops, column: int) -> int:
    """The column a TAB in ``column`` pads to.

    The chosen stop is the first one STRICTLY greater than the current
    column, so a TAB sitting exactly on a stop takes the next one
    (``expand -t 2,5`` turns ``ab\\tc`` into ``ab`` and three blanks).
    Past the last explicit stop GNU has four different answers and they
    are all observable:

    * ``/N`` rounds up to a strictly greater multiple of N.
    * ``+N`` adds N to the last explicit stop, repeatedly.
    * ONE explicit stop repeats as a tab SIZE, which is what makes
      ``-t 3`` mean 3, 6, 9 and not "one stop at 3".
    * SEVERAL explicit stops give exactly one blank, forever, so
      ``-t 5,9`` pads column 10 by one where ``-t 5`` pads it by five.

    No stops and neither specifier is the default size 8.

    Args:
        tabs (TabStops): the resolved tab list.
        column (int): the current output column, counting from 0.

    Returns:
        int: the column to pad to, always greater than ``column``.
    """
    for stop in tabs.stops:
        if stop > column:
            return stop
    if tabs.extend:
        return column + tabs.extend - column % tabs.extend
    if tabs.increment:
        last = tabs.stops[-1] if tabs.stops else 0
        return last + tabs.increment * ((column - last) // tabs.increment + 1)
    if len(tabs.stops) == 1:
        size = tabs.stops[0]
        return column + size - column % size
    if tabs.stops:
        return column + 1
    return column + _DEFAULT_TAB_SIZE - column % _DEFAULT_TAB_SIZE


def _expand_text(text: str, tabs: TabStops) -> str:
    """Replace every TAB with blanks up to its tab stop.

    Only a NEWLINE resets the column, and only a BACKSPACE moves it
    left. A carriage return does neither:
    ``printf 'a\\r\\tb\\n' | expand`` pads by six, not eight, because the
    ``\\r`` advanced the column to 2 like any other character. Python's
    ``str.expandtabs`` treats ``\\r`` as a line break and so cannot be
    used here (it also disagrees with the TypeScript twin, which never
    reset on one).

    Backspace decrements, floored at 0, so ``printf 'a\\bb\\tX\\n'`` pads
    by seven (column 1, 0, 1) while ``printf '\\b\\tX\\n'`` pads by eight
    -- three leading backspaces still leave column 0. It composes with
    the tab-stop list like any other column, which is why it is one
    branch here and not a special case: under ``-t 1,3`` the same input
    pads by two, the first stop past column 1. ``\\v`` and ``\\f`` are
    ordinary and advance. Measured, ground truth NL3-E.

    Args:
        text (str): the decoded input.
        tabs (TabStops): the resolved tab list.
    """
    out: list[str] = []
    column = 0
    for char in text:
        if char == "\t":
            target = next_tab_stop(tabs, column)
            out.append(" " * (target - column))
            column = target
        elif char == "\n":
            out.append(char)
            column = 0
        elif char == "\b":
            out.append(char)
            column = max(column - 1, 0)
        else:
            out.append(char)
            column += 1
    return "".join(out)


def _expand_leading_tabs(text: str, tabs: TabStops) -> str:
    """``-i``: expand only the blanks before a line's first other byte.

    Args:
        text (str): the decoded input.
        tabs (TabStops): the resolved tab list.
    """
    out: list[str] = []
    for line in text.split("\n"):
        index = 0
        while index < len(line) and line[index] in _BLANKS:
            index += 1
        if index == 0:
            out.append(line)
        else:
            out.append(_expand_text(line[:index], tabs) + line[index:])
    return "\n".join(out)


def apply_expand(text: str, tabs: TabStops, initial_only: bool) -> str:
    if initial_only:
        return _expand_leading_tabs(text, tabs)
    return _expand_text(text, tabs)


async def expand(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
    tabs: TabStops | None = None,
    initial_only: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    stops = tabs if tabs is not None else TabStops()
    if paths:
        all_text: list[str] = []
        for p in paths:
            data = (await read_bytes(p)).decode(errors="replace")
            all_text.append(apply_expand(data, stops, initial_only))
        return "".join(all_text).encode(), IOResult()

    raw = await read_stdin_async(stdin)
    if raw is None:
        raise ValueError("expand: missing operand")
    text = raw.decode(errors="replace")
    return apply_expand(text, stops, initial_only).encode(), IOResult()


async def expand_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run expand over resolved operands; mirrors expandGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by expand.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    try:
        parsed = parse_flags(opts.flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=f"{exc}\n".encode())
    readable, err = await split_readable(paths, stat, "expand")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await expand(readable,
                     read_bytes=materialized_read(stream),
                     stdin=opts.stdin,
                     tabs=parsed.tabs,
                     initial_only=parsed.initial_only), err)


__all__ = [
    "ExpandFlags", "TabStops", "apply_expand", "expand", "expand_generic",
    "next_tab_stop", "parse_flags", "parse_tab_stops"
]
