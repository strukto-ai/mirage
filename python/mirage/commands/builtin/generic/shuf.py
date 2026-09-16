import random
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from enum import Enum

from mirage.commands.builtin.constants import C_SPACE
from mirage.commands.builtin.utils.lines import split_lines
from mirage.commands.builtin.utils.stream import read_stdin_async
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

# A `-o` reached a backend wired without a write op, which is a wiring
# fault rather than anything the command line did wrong. The TypeScript
# twin throws a bare `Error` for it where it RETURNS an IOResult for
# every user-facing refusal, so the builder's local catch has to let
# this one through; naming it here is what keeps the two in step.
NO_WRITE_OP = "shuf: backend provides no write op"

# GNU's own `xalloc_die` wording, exit 1. It is what real shuf answers
# with when a range is too large to materialize, so it is borrowed
# rather than invented. Measured, ground truth SH5.
MEMORY_EXHAUSTED = "shuf: memory exhausted"

# `-i`'s bounds are `uintmax_t`, so a bound one past UINTMAX_MAX is
# refused with gnulib's LONGINT_OVERFLOW clause appended. The clause is
# EOVERFLOW's `strerror`, not ERANGE's: `nl -w` produces both and they
# read differently (`: Numerical result out of range` is the value
# outside an option's OWN range), while `shuf -i` has no range below the
# C type's and so only ever emits this one. Measured, ground truth SH1.
OVERFLOW_CLAUSE = ": Value too large for defined data type"

UINTMAX_MAX = 18446744073709551615
SIZE_MAX = 18446744073709551615

# How many lines shuf will render into one byte object before answering
# `memory exhausted`. GNU has no such number: it streams, so a huge
# range with no `-n` merely allocates until the allocator gives up
# (which it did at 1e8 elements under a 512 MiB cap and not at all
# without one, so the threshold is an allocator outcome and not a spec --
# ground truth SH5). mirage cannot stream, because a command answers
# with one rendered object, so the ceiling is stated here instead of
# being whatever the host happens to survive. This is the deliberate
# divergence: a range GNU would enumerate given enough memory is refused
# above this, with GNU's own wording for the same situation.
MAX_OUTPUT_LINES = 1_000_000

# One unsigned value as `strtoumax` reads it, which is both `-n`'s whole
# argument and each `-i` bound.
#
# GNU accepts a leading `+` and reads `+2` as 2, and `0` is a valid head
# count. A `-` is not a sign here but an invalid character, so `-1` is
# refused and quoted whole with no out-of-range clause: shuf rejects the
# sign while scanning rather than range-checking a parsed negative.
#
# Matched with `fullmatch`, never `match`: python's `$` also matches
# immediately BEFORE a trailing newline, so `^...$` with `match` reads
# `shuf -n $'2\n'` as the valid count 2. GNU's scanner stops at the
# first non-digit and refuses it, as does the TypeScript twin.
#
# The leading `C_SPACE` run is `strtoumax`'s own skip and is real GNU
# behavior: `shuf -n ' 2'`, `$'\t2'`, `$'\n2'` and `' +2'` are all
# accepted while `'2 '` is refused. Measured, ground truth NL3-C.
#
# GNU splits an `-i` argument at the FIRST dash and hands each side to
# its own scan, so a bound carries its own whitespace and `+`:
# `-i +1-3`, `-i 1-+3` and `-i '1- 3'` are all accepted (the blank
# belongs to the HIGH bound), while `-i '1 -3'` is refused because the
# blank is trailing garbage on the low one. A `-` is never a sign, which
# is why `-i -1-3` (an empty low bound) and `-i 1--3` (a negative high
# bound) are both refused, and why there is no separate decreasing-range
# message. Measured, ground truth NL3-D.
_UNSIGNED = re.compile(rf"{C_SPACE}\+?[0-9]+")

# `-i` takes two unsigned bounds with the low one no greater than the
# high one, and shuf answers every shape it will not read with ONE
# message quoting the argument whole -- so a negative low bound (`-2-1`)
# and a decreasing range (`3-1`) read identically, and there is no
# decreasing-range diagnostic to borrow from cut. The single exception is
# a magnitude the C type cannot hold, which appends a clause; the two
# outcomes are what the enum below names.


class RangeRefusal(Enum):
    """Which of GNU's two `-i` refusals an argument earned.

    Not a sentinel pair but two real answers with different bytes:
    INVALID is gnulib's LONGINT_INVALID and prints the bare
    `invalid input range: '<arg>'`, while OVERFLOW is LONGINT_OVERFLOW
    and appends `OVERFLOW_CLAUSE`. The span limit (SH3) is INVALID, not
    OVERFLOW, even though it is a magnitude that trips it.
    """

    INVALID = "invalid"
    OVERFLOW = "overflow"


def range_error(raw: str, refusal: RangeRefusal) -> str:
    """Render the one `-i` diagnostic, with the clause iff it is earned.

    Args:
        raw (str): the raw ``-i`` value, quoted whole as GNU quotes it.
        refusal (RangeRefusal): which gnulib status the scan produced.

    Returns:
        str: the single stderr line, without its newline.
    """
    clause = OVERFLOW_CLAUSE if refusal is RangeRefusal.OVERFLOW else ""
    return f"shuf: invalid input range: '{quote_text(raw)}'{clause}"


@dataclass(frozen=True, slots=True)
class ShufFlags:
    count: int | None = None
    echo: bool = False
    zero_terminated: bool = False
    with_replacement: bool = False
    input_range: str | None = None
    output: PathSpec | None = None


def parse_input_range(raw: str) -> tuple[int, int] | RangeRefusal:
    """GNU's ``-i LO-HI``, read the way GNU reads it.

    Split at the FIRST dash and scan each side on its own, which is what
    ``strchr(optarg, '-')`` plus two ``strtoumax`` calls amount to. Doing
    it as one regex over the whole argument gets three shapes wrong:
    ``-i +1-3`` and ``-i 1-+3`` carry a ``+`` on either bound
    independently, ``-i '1- 3'`` puts the blank on the HIGH bound's
    prefix and is accepted, and ``-i '1 -3'`` is refused because that
    same blank is trailing garbage on the LOW one.

    A ``-`` is never a sign here, so an empty low bound (``-i -1-3``,
    where the first dash is at index 0) and a negative high bound
    (``-i 1--3``) are both refused, as is a second dash anywhere
    (``-i 1-2-3``). Measured, ground truth NL3-D.

    Two magnitude limits sit on top of that shape, they are different
    limits, and they print differently. A BOUND may be as large as
    UINTMAX_MAX and one past it is OVERFLOW; the SPAN ``high - low`` must
    be strictly under SIZE_MAX and the one argument that trips that
    (``-i 0-18446744073709551615``, whose element count is 2**64) is
    INVALID with no clause, exactly as a decreasing range is. The scan is
    left to right and stops at the first failure, so an overflowing low
    bound outranks a non-numeric high one (``-i 18446744073709551616-x``
    is OVERFLOW) while a non-numeric low bound outranks an overflowing
    high one (``-i x-18446744073709551616`` is INVALID). Measured,
    ground truth SH1, SH3 and SH4.

    The bounds come back as python ints, which are arbitrary precision,
    so nothing here narrows a 20-digit bound. The TypeScript twin returns
    ``bigint`` for the same reason: read as float64, a bound at 2**53
    increments to itself and enumerating the range never terminates,
    and 2**53+1 parses to the wrong integer outright (SH2).

    Args:
        raw (str): the raw ``-i`` value.

    Returns:
        tuple[int, int] | RangeRefusal: the inclusive bounds, or which of
            GNU's two refusals the argument earned.
    """
    dash = raw.find("-")
    if dash < 0:
        return RangeRefusal.INVALID
    low_raw = raw[:dash]
    high_raw = raw[dash + 1:]
    if _UNSIGNED.fullmatch(low_raw) is None:
        return RangeRefusal.INVALID
    low = int(low_raw)
    if low > UINTMAX_MAX:
        return RangeRefusal.OVERFLOW
    if _UNSIGNED.fullmatch(high_raw) is None:
        return RangeRefusal.INVALID
    high = int(high_raw)
    if high > UINTMAX_MAX:
        return RangeRefusal.OVERFLOW
    if low > high or high - low >= SIZE_MAX:
        return RangeRefusal.INVALID
    return low, high


def emit_count(available: int, count: int | None,
               with_replacement: bool) -> int:
    """How many lines shuf will emit, before any of them are built.

    Computed rather than discovered, because ``-i`` can name 2**64
    values and GNU answers ``-i 1-18446744073709551615 -n 3`` instantly
    by never building the population (SH5). Knowing the emitted count up
    front is what lets the range path sample instead of enumerate, and
    what lets an output larger than `MAX_OUTPUT_LINES` be refused
    without allocating it.

    ``-r`` draws independently, so it emits exactly the requested count
    however few values it is drawing from -- except from nothing at all,
    which emits nothing. Without ``-r`` the count is a head count over a
    permutation, so it cannot exceed what is available.

    Args:
        available (int): how many values the source holds; for ``-i``
            the element count, which may be far past 2**53.
        count (int | None): the ``-n`` value, already clamped to
            SIZE_MAX, or None when the line carried no ``-n``.
        with_replacement (bool): whether ``-r`` was given.

    Returns:
        int: the number of lines the command will render.
    """
    if with_replacement:
        if available == 0:
            return 0
        return available if count is None else count
    if count is None:
        return available
    return min(count, available)


def parse_flags(flags: Mapping[str, FlagValue]) -> ShufFlags:
    """Read shuf's flags once, refusing a head count GNU refuses.

    GNU quotes the WHOLE ``-n`` argument, not just the unparsed
    remainder the way expand and cut do, and never appends an
    out-of-range clause to it. Pre-validated the way head/tail do it, so
    the ``int`` below cannot see a prefix.

    A ``-n`` past UINTMAX_MAX is CLAMPED, never refused, which is the
    opposite of what ``-i`` does with the same overflow: ``xstrtoumax``
    answering LONGINT_OVERFLOW is fatal for ``-i`` and is quietly read
    as SIZE_MAX for ``-n``, so ``shuf -n 99999999999999999999999999``
    exits 0. The clamp is written down rather than left to the host's
    own integers: python would carry the bignum and TypeScript's
    ``Number.parseInt`` answers ``Infinity`` for a 400-digit count,
    which is not a number either host can act on. Measured, ground
    truth SH6.

    Args:
        flags (Mapping[str, FlagValue]): the dispatcher's flag bag.

    Raises:
        ValueError: the single stderr line to print, exit 1.
    """
    fl = FlagView(flags, spec=SPECS["shuf"])
    count_raw = fl.as_str("head_count")
    if count_raw is not None and _UNSIGNED.fullmatch(count_raw) is None:
        raise ValueError(
            f"shuf: invalid line count: '{quote_text(count_raw)}'")
    outputs = fl.as_paths("output")
    return ShufFlags(
        count=min(int(count_raw), SIZE_MAX) if count_raw is not None else None,
        echo=fl.as_bool("echo"),
        zero_terminated=fl.as_bool("zero_terminated"),
        with_replacement=fl.as_bool("repeat"),
        input_range=fl.as_str("input_range"),
        output=outputs[0] if outputs else None,
    )


def _render(result: list[str], sep: str) -> bytes:
    """Terminate every emitted line, and emit nothing for no lines.

    ``shuf -n 0`` is valid and prints zero bytes, so the separator is
    per line rather than appended to the join.

    Args:
        result (list[str]): the sampled lines, already in output order.
        sep (str): the line terminator, NUL under ``-z``.

    Returns:
        bytes: the rendered output, empty when nothing was sampled.
    """
    if not result:
        return b""
    return (sep.join(result) + sep).encode()


def _need(available: int, count: int | None, with_replacement: bool) -> int:
    """`emit_count`, refusing an output too large to render.

    Args:
        available (int): how many values the source holds.
        count (int | None): the clamped ``-n`` value, or None.
        with_replacement (bool): whether ``-r`` was given.

    Raises:
        ValueError: `MEMORY_EXHAUSTED`, which the builder turns into
            GNU's one-line stderr and exit 1.
    """
    need = emit_count(available, count, with_replacement)
    if need > MAX_OUTPUT_LINES:
        raise ValueError(MEMORY_EXHAUSTED)
    return need


def _sample(items: list[str], count: int | None,
            with_replacement: bool) -> list[str]:
    need = _need(len(items), count, with_replacement)
    if with_replacement:
        return random.choices(items, k=need) if items else []
    out = list(items)
    random.shuffle(out)
    return out[:need]


def _range_lines(low: int, high: int, need: int,
                 with_replacement: bool) -> list[str]:
    """Emit `need` values from the inclusive range, never enumerating it.

    GNU is lazy exactly here: with a ``-n`` below the element count it
    never builds the population, which is why
    ``shuf -i 1-18446744073709551615 -n 3`` answers instantly (SH5). So
    the range is materialized only when it is small enough to be, and
    otherwise the sample is drawn value by value.

    The draw loop terminates because `need` is at most
    `MAX_OUTPUT_LINES`, which the first branch has already established
    is below the element count, so there is always an undrawn value
    left. Drawing in sequence, rejecting a repeat, is sampling without
    replacement in order -- the same distribution as shuffling the whole
    population and taking a prefix.

    Args:
        low (int): the inclusive low bound, possibly past 2**53.
        high (int): the inclusive high bound.
        need (int): how many lines to emit, already capped.
        with_replacement (bool): whether ``-r`` was given, which makes
            every draw independent and needs no population at all.

    Returns:
        list[str]: the values as decimal strings, in output order.
    """
    if with_replacement:
        return [str(random.randint(low, high)) for _ in range(need)]
    if high - low + 1 <= MAX_OUTPUT_LINES:
        items = [str(value) for value in range(low, high + 1)]
        random.shuffle(items)
        return items[:need]
    drawn: set[int] = set()
    out: list[str] = []
    while len(out) < need:
        value = random.randint(low, high)
        if value in drawn:
            continue
        drawn.add(value)
        out.append(str(value))
    return out


async def shuf(
    paths: list[PathSpec],
    texts: list[str],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    stdin: ByteSource | None = None,
    count: int | None = None,
    echo: bool = False,
    zero_terminated: bool = False,
    with_replacement: bool = False,
    input_range: str | None = None,
    output: PathSpec | None = None,
    write_bytes: Callable[[PathSpec, bytes], Awaitable[None]] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    sep = "\x00" if zero_terminated else "\n"

    if input_range is not None:
        bounds = parse_input_range(input_range)
        if isinstance(bounds, RangeRefusal):
            raise ValueError(range_error(input_range, bounds))
        low, high = bounds
        need = _need(high - low + 1, count, with_replacement)
        result = _range_lines(low, high, need, with_replacement)
        rendered = _render(result, sep)
    elif echo:
        items = [p.mount_path for p in paths] if paths else list(texts)
        result = _sample(items, count, with_replacement)
        rendered = _render(result, sep)
    elif paths:
        all_lines: list[str] = []
        for p in paths:
            data = (await read_bytes(p)).decode(errors="replace")
            if zero_terminated:
                all_lines.extend(data.split("\x00"))
            else:
                all_lines.extend(split_lines(data))
        result = _sample(all_lines, count, with_replacement)
        rendered = _render(result, sep)
    else:
        raw = await read_stdin_async(stdin)
        if raw is None:
            raise ValueError("shuf: missing operand")
        text = raw.decode(errors="replace")
        lines = text.split("\x00") if zero_terminated else split_lines(text)
        result = _sample(lines, count, with_replacement)
        rendered = _render(result, sep)
    if output is not None:
        if write_bytes is None:
            raise ValueError(NO_WRITE_OP)
        await write_bytes(output, rendered)
        return None, IOResult(writes={output.mount_path: rendered})
    return rendered, IOResult()


__all__ = [
    "MAX_OUTPUT_LINES", "MEMORY_EXHAUSTED", "NO_WRITE_OP", "OVERFLOW_CLAUSE",
    "SIZE_MAX", "UINTMAX_MAX", "RangeRefusal", "ShufFlags", "emit_count",
    "parse_flags", "parse_input_range", "range_error", "shuf"
]
