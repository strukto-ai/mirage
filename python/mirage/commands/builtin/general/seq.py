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

import itertools
import math
import re
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from enum import Enum
from typing import NamedTuple

from mirage.accessor.base import Accessor
from mirage.commands.builtin.general.expr import digits_of_int, int_of_digits
from mirage.commands.builtin.utils.strtod import strtod_whole
from mirage.commands.config import CommandOpts, command
from mirage.commands.errors import UsageError
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandName
from mirage.commands.spec.usage import (
    extra_operand_error,
    missing_operand_error,
    usage_exit_code,
    usage_hint,
)
from mirage.io.types import ByteSource, IOResult
from mirage.io.yield_budget import YieldBudget
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec

# GNU seq's long_double_format: one floating directive, its flags and an
# optional L, with nothing but %% around it.
FORMAT_DIRECTIVE = re.compile(r"([-+#0 ']*)([0-9]*)(?:\.([0-9]*))?(L?)")
FLOAT_CONVERSIONS = "efgaEFGA"

# The magnitude from which strtold reads an infinity on x86-64, whose
# long double keeps 64 mantissa bits: halfway from LDBL_MAX to 2**16384,
# a tie that rounds up to the even 2**16384. GNU refuses an operand that
# large. arm64's 113-bit long double moves the edge by a part in 2**65.
LONG_DOUBLE_OVERFLOW = (2**65 - 1) << 16319

# strtold reads zero for a magnitude at or under 2**-UNDERFLOW_BITS, half
# of the x86-64 long double's least subnormal, and GNU takes the zero.
UNDERFLOW_BITS = 16446

# About how many bytes of output one chunk of the stream carries.
OUTPUT_CHUNK = 64 * 1024


@dataclass(frozen=True)
class SeqFormat:
    """A seq format split around its one directive: a ``-f`` format GNU
    accepts, or the default one.

    Args:
        prefix (str): the text before the directive, ``%%`` kept.
        flags (str): the directive's flags.
        width (str): its field width, or empty.
        precision (str | None): its precision digits, or None.
        conversion (str): the floating conversion character.
        suffix (str): the text after the directive, ``%%`` kept.
    """

    prefix: str
    flags: str
    width: str
    precision: str | None
    conversion: str
    suffix: str


def _lone_percent(text: str) -> int:
    """Index of the first ``%`` that is not half of ``%%``, or -1.

    Args:
        text (str): the format text to scan.
    """
    i = 0
    while i < len(text):
        if text[i] == "%":
            if text[i + 1 : i + 2] != "%":
                return i
            i += 2
            continue
        i += 1
    return -1


def parse_format(fmt: str) -> SeqFormat:
    """GNU seq's ``-f`` check: exactly one floating ``%`` directive.

    Args:
        fmt (str): the format as typed.
    """
    shown = f"'{quote_text(fmt)}'"
    start = _lone_percent(fmt)
    if start < 0:
        raise UsageError(f"seq: format {shown} has no % directive", 1)
    match = FORMAT_DIRECTIVE.match(fmt, start + 1)
    end = match.end() if match else start + 1
    if end >= len(fmt):
        raise UsageError(f"seq: format {shown} ends in %", 1)
    if fmt[end] not in FLOAT_CONVERSIONS:
        raise UsageError(
            f"seq: format {shown} has unknown %{fmt[end]} directive", 1
        )
    suffix = fmt[end + 1 :]
    if _lone_percent(suffix) >= 0:
        raise UsageError(f"seq: format {shown} has too many % directives", 1)
    flags, width, precision, _ = (
        match.groups() if match else ("", "", None, "")
    )
    return SeqFormat(fmt[:start], flags, width, precision, fmt[end], suffix)


def _hex_float(value: float, spec: SeqFormat) -> str:
    """``value`` through a ``%a`` directive, as glibc renders it.

    The hex digits round half to even at the precision without
    renormalizing (``%.0a`` of 3 is ``0x2p+1``), ``#`` keeps the point
    and ``0`` pads after ``0x``. GNU's value is a long double, so a value
    needing more than a double's 53 bits shows fewer digits here.

    Args:
        value (float): the value to print.
        spec (SeqFormat): the parsed format.
    """
    flags = spec.flags
    sign = (
        "-"
        if math.copysign(1.0, value) < 0
        else "+"
        if "+" in flags
        else " "
        if " " in flags
        else ""
    )
    magnitude = abs(float(value))
    zero = False
    if not math.isfinite(magnitude):
        body = "nan" if math.isnan(magnitude) else "inf"
    else:
        mantissa, exponent = magnitude.hex().split("p")
        lead, _, digits = mantissa[2:].partition(".")
        if spec.precision is None:
            digits = digits.rstrip("0")
        else:
            places = int(spec.precision or "0")
            if places >= len(digits):
                digits = digits.ljust(places, "0")
            else:
                kept = int(lead + digits[:places], 16)
                rest = int(digits[places:], 16)
                half = 8 << 4 * (len(digits) - places - 1)
                if rest > half or (rest == half and kept % 2):
                    kept += 1
                text = f"{kept:0{places + 1}x}"
                lead, digits = (
                    text[: len(text) - places],
                    text[len(text) - places :],
                )
        point = "." if digits or "#" in flags else ""
        body = f"0x{lead}{point}{digits}p{int(exponent):+d}"
        zero = "0" in flags and "-" not in flags
    if spec.conversion == "A":
        body = body.upper()
    width = int(spec.width or "0")
    if "-" in flags:
        return (sign + body).ljust(width)
    if zero:
        return sign + body[:2] + body[2:].rjust(width - len(sign) - 2, "0")
    return (sign + body).rjust(width)


class NumberKind(Enum):
    FINITE = "finite"
    INFINITE = "infinite"
    NAN = "nan"


class SeqNumber(NamedTuple):
    """A number as GNU seq holds it, held exactly: ``units / 10**scale``.

    GNU computes in long double, whose rounding depends on the machine
    (64 mantissa bits on x86-64, 113 on arm64). Exact values print what
    GNU prints wherever its own output does not depend on that.

    Args:
        negative (bool): the sign, kept for a zero too (``seq -0 1``
            prints ``-0``).
        units (int): the magnitude in steps of ``10**-scale``, 0 for an
            infinity or a NaN.
        scale (int): the decimal places ``units`` counts.
        kind (NumberKind): finite, an infinity or not a number.
    """

    negative: bool
    units: int = 0
    scale: int = 0
    kind: NumberKind = NumberKind.FINITE


@dataclass(frozen=True)
class SeqOperand:
    """An operand as GNU seq's scan_arg reads it.

    Args:
        value (SeqNumber): what it names.
        width (int): its print width in the form it was typed (``-.1``
            counts as ``-0.1`` and ``1.`` as ``1``), 0 for a hex number
            or an infinity.
        precision (int | None): its digits after the point, or None when
            it is no fixed-point number (a hex float with a point or a
            ``p`` exponent).
    """

    value: SeqNumber
    width: int
    precision: int | None


# FIRST and INCREMENT when the line leaves them out.
ONE = SeqOperand(SeqNumber(False, 1), 1, 0)

# The default format for whole numbers, ``%.0f``, which GNU's seq_fast
# prints without printf.
PLAIN = SeqFormat("", "", "", "0", "f", "")


def _refuse(line: str) -> UsageError:
    """A seq refusal followed by the ``Try`` hint, as usage() ends it.

    Args:
        line (str): the diagnostic after ``seq: ``.
    """
    return UsageError(
        f"seq: {line}\n{usage_hint(CommandName.SEQ)}",
        usage_exit_code(CommandName.SEQ),
    )


def _signed_digits(text: str) -> int:
    """A decimal exponent's digits, sign and all, as an int at any length.

    Args:
        text (str): the digits with an optional sign.
    """
    return int_of_digits(text.removeprefix("+"))


def _in_range(negative: bool, units: int, scale: int) -> SeqNumber | None:
    """``units / 10**scale`` as strtold bounds it.

    Args:
        negative (bool): the sign.
        units (int): the magnitude in steps of ``10**-scale``.
        scale (int): the decimal places ``units`` counts.

    Returns:
        SeqNumber | None: the number, zero when it underflows, None when
            it overflows.
    """
    denominator = 10**scale
    if units >= LONG_DOUBLE_OVERFLOW * denominator:
        return None
    if units << UNDERFLOW_BITS <= denominator:
        return SeqNumber(negative)
    return SeqNumber(negative, units, scale)


def read_number(found: re.Match[str]) -> SeqNumber | None:
    """The value strtold reads for a STRTOD match, held exactly.

    A magnitude far outside the long double range is settled from its
    digit count before any arithmetic (from 10**4933 up it overflows,
    under 10**-4951 it is zero, as are 2**16384 and 2**-16446 for a hex
    float), so an exponent of any length costs nothing.

    Args:
        found (re.Match[str]): a whole-word STRTOD match.

    Returns:
        SeqNumber | None: the value, or None when it overflows.
    """
    sign, hexa, decimal, inf, _nan = found.groups()
    negative = sign == "-"
    if inf is not None:
        return SeqNumber(negative, kind=NumberKind.INFINITE)
    if decimal is not None:
        mantissa, _, power = decimal.lower().partition("e")
        whole, _, fraction = mantissa.partition(".")
        digits = (whole + fraction).lstrip("0")
        significant = digits.rstrip("0")
        if not significant:
            return SeqNumber(negative)
        exponent = (
            _signed_digits(power or "0")
            - len(fraction)
            + len(digits)
            - len(significant)
        )
        top = len(significant) + exponent
        if top > 4933:
            return None
        if top < -4950:
            return SeqNumber(negative)
        units = int_of_digits(significant)
        if exponent >= 0:
            return _in_range(negative, units * 10**exponent, 0)
        return _in_range(negative, units, -exponent)
    if hexa is not None:
        mantissa, _, power = hexa[2:].lower().partition("p")
        whole, _, fraction = mantissa.partition(".")
        bits = int(whole + fraction, 16)
        if not bits:
            return SeqNumber(negative)
        exponent = _signed_digits(power or "0") - 4 * len(fraction)
        top = bits.bit_length() + exponent
        if top > 16384:
            return None
        if top < -16445:
            return SeqNumber(negative)
        shift = min((bits & -bits).bit_length() - 1, max(-exponent, 0))
        bits >>= shift
        exponent += shift
        if exponent >= 0:
            return _in_range(negative, bits << exponent, 0)
        return _in_range(negative, bits * 5**-exponent, -exponent)
    return SeqNumber(negative, kind=NumberKind.NAN)


def scan_operand(text: str) -> SeqOperand:
    """GNU seq's scan_arg: an operand's value, print width and precision.

    The width and precision come from the digits as typed, so ``1.50``
    prints two decimals and ``1e2`` none. A hex operand has no width,
    and one with a point or a lowercase ``p`` no precision either.

    Args:
        text (str): the operand as typed.
    """
    found = strtod_whole(text)
    value = None if found is None else read_number(found)
    if value is None:
        raise _refuse(f"invalid floating point argument: '{quote_text(text)}'")
    if value.kind is NumberKind.NAN:
        raise _refuse(f"invalid 'not-a-number' argument: '{quote_text(text)}'")
    shown = text.lstrip(" \t\n\v\f\r+")
    point = shown.find(".")
    precision = None if point >= 0 or "p" in shown else 0
    width = 0
    if value.kind is NumberKind.FINITE and "x" not in shown.lower():
        width = len(shown)
        fraction = 0
        if point >= 0:
            fraction = len(re.split("[eE]", shown[point + 1 :])[0])
            precision = fraction
            if not fraction:
                width -= 1
            elif point == 0 or shown[point - 1] not in "0123456789":
                width += 1
        marker = max(shown.find("e"), shown.find("E"))
        if marker >= 0 and precision is not None:
            exponent = _signed_digits(shown[marker + 1 :])
            precision += (
                -exponent if exponent < 0 else -min(precision, exponent)
            )
            width -= len(shown) - marker
            if exponent < 0:
                if point < 0 or marker == point + 1:
                    width += 1
                exponent = -exponent
            else:
                if point >= 0 and not precision and fraction:
                    width -= 1
                exponent -= min(fraction, exponent)
            width += exponent
    return SeqOperand(value, width, precision)


def default_format(
    first: SeqOperand, step: SeqOperand, last: SeqOperand, equal_width: bool
) -> SeqFormat:
    """GNU seq's get_default_format.

    ``%.PRECf`` with the operands' widest precision, zero-padded to the
    wider of FIRST and LAST under ``-w``, and ``%g`` once any operand is
    no fixed-point number.

    Args:
        first (SeqOperand): FIRST.
        step (SeqOperand): INCREMENT.
        last (SeqOperand): LAST.
        equal_width (bool): whether ``-w`` was given.
    """
    if (
        first.precision is None
        or step.precision is None
        or last.precision is None
    ):
        return SeqFormat("", "", "", None, "g", "")
    precision = max(first.precision, step.precision)
    if not equal_width:
        return SeqFormat("", "", "", str(precision), "f", "")
    first_width = first.width + precision - first.precision
    last_width = last.width + precision - last.precision
    if last.precision and not precision:
        last_width -= 1
    if not last.precision and precision:
        last_width += 1
    if not first.precision and precision:
        first_width += 1
    width = max(first_width, last_width)
    return SeqFormat("", "0", str(width), str(precision), "f", "")


def _rounded(units: int, drop: int) -> int:
    """``units / 10**drop`` rounded half to even, exact for a negative drop.

    Args:
        units (int): the magnitude to round.
        drop (int): how many trailing digits to round away.
    """
    if drop <= 0:
        factor: int = 10**-drop
        return units * factor
    unit: int = 10**drop
    kept, rest = divmod(units, unit)
    half = unit // 2
    if rest > half or (rest == half and kept % 2):
        kept += 1
    return kept


def _fixed_text(value: SeqNumber, precision: int, alternate: bool) -> str:
    """A finite magnitude in ``%f`` style.

    Args:
        value (SeqNumber): the number; its sign is not written.
        precision (int): the digits after the point.
        alternate (bool): the ``#`` flag, which keeps a bare point.
    """
    digits = digits_of_int(_rounded(value.units, value.scale - precision))
    digits = digits.rjust(precision + 1, "0")
    if precision:
        return f"{digits[:-precision]}.{digits[-precision:]}"
    return digits + ("." if alternate else "")


def _exponent_text(value: SeqNumber, precision: int, alternate: bool) -> str:
    """A finite magnitude in ``%e`` style.

    Args:
        value (SeqNumber): the number; its sign is not written.
        precision (int): the digits after the point.
        alternate (bool): the ``#`` flag, which keeps a bare point.
    """
    exponent = 0
    digits = "0" * (precision + 1)
    if value.units:
        exponent = len(digits_of_int(value.units)) - 1 - value.scale
        kept = _rounded(value.units, value.scale + exponent - precision)
        if kept == 10 ** (precision + 1):
            kept //= 10
            exponent += 1
        digits = digits_of_int(kept)
    point = "." if precision or alternate else ""
    mark = "-" if exponent < 0 else "+"
    return f"{digits[0]}{point}{digits[1:]}e{mark}{abs(exponent):02d}"


def _general_text(value: SeqNumber, precision: int, alternate: bool) -> str:
    """A finite magnitude in ``%g`` style.

    ``%e`` when the exponent is under -4 or reaches the precision, ``%f``
    otherwise, and trailing zeros dropped unless ``#`` is given.

    Args:
        value (SeqNumber): the number; its sign is not written.
        precision (int): the significant digits, 0 meaning 1.
        alternate (bool): the ``#`` flag.
    """
    significant = precision or 1
    exponent = 0
    if value.units:
        exponent = len(digits_of_int(value.units)) - 1 - value.scale
        drop = value.scale + exponent - significant + 1
        if _rounded(value.units, drop) == 10**significant:
            exponent += 1
    if -4 <= exponent < significant:
        text = _fixed_text(value, significant - 1 - exponent, alternate)
    else:
        text = _exponent_text(value, significant - 1, alternate)
    if alternate:
        return text
    mantissa, mark, power = text.partition("e")
    if "." in mantissa:
        mantissa = mantissa.rstrip("0").rstrip(".")
    return mantissa + mark + power


def _float_text(value: SeqNumber, spec: SeqFormat) -> str:
    """``value`` through a ``%e``, ``%f`` or ``%g`` directive, as printf.

    The digits round half to even on the exact value. GNU rounds its
    long double, so a number that sits exactly halfway at the last
    printed digit (``seq -f %.1f 0.05 0.1 0.45``) may round the other
    way there, and differently on x86-64 and arm64.

    Args:
        value (SeqNumber): the number to print.
        spec (SeqFormat): the parsed format.
    """
    flags = spec.flags
    sign = (
        "-"
        if value.negative
        else "+"
        if "+" in flags
        else " "
        if " " in flags
        else ""
    )
    zero = "0" in flags and "-" not in flags
    if value.kind is not NumberKind.FINITE:
        body = "nan" if value.kind is NumberKind.NAN else "inf"
        zero = False
    else:
        precision = 6 if spec.precision is None else int(spec.precision or "0")
        alternate = "#" in flags
        kind = spec.conversion.lower()
        if kind == "f":
            body = _fixed_text(value, precision, alternate)
        elif kind == "e":
            body = _exponent_text(value, precision, alternate)
        else:
            body = _general_text(value, precision, alternate)
    if spec.conversion.isupper():
        body = body.upper()
    width = int(spec.width or "0")
    if "-" in flags:
        return (sign + body).ljust(width)
    if zero:
        return sign + body.rjust(width - len(sign), "0")
    return (sign + body).rjust(width)


def _to_float(value: SeqNumber) -> float:
    """The nearest double, for the ``%a`` directive.

    Args:
        value (SeqNumber): the number.
    """
    if value.kind is NumberKind.NAN:
        return math.nan
    magnitude = (
        math.inf
        if value.kind is NumberKind.INFINITE
        else float(f"{digits_of_int(value.units)}e-{value.scale}")
    )
    return -magnitude if value.negative else magnitude


def render(spec: SeqFormat, value: SeqNumber) -> str:
    """One number through a seq format, as C's printf renders it.

    Args:
        spec (SeqFormat): the parsed format.
        value (SeqNumber): the number to print.
    """
    if spec.conversion in "aA":
        body = _hex_float(_to_float(value), spec)
    else:
        body = _float_text(value, spec)
    return (
        spec.prefix.replace("%%", "%") + body + spec.suffix.replace("%%", "%")
    )


def _signed(value: SeqNumber) -> int:
    """A finite number's units with its sign.

    Args:
        value (SeqNumber): the number.
    """
    return -value.units if value.negative else value.units


def _rank(value: SeqNumber) -> int:
    """-1 for minus infinity, 1 for infinity, 0 for a finite number.

    Args:
        value (SeqNumber): a number that is not a NaN.
    """
    if value.kind is NumberKind.FINITE:
        return 0
    return -1 if value.negative else 1


def _less(a: SeqNumber, b: SeqNumber) -> bool:
    """``a < b`` as C compares two long doubles: never true for a NaN.

    Args:
        a (SeqNumber): the left number.
        b (SeqNumber): the right number.
    """
    if NumberKind.NAN in (a.kind, b.kind):
        return False
    if NumberKind.INFINITE in (a.kind, b.kind):
        return _rank(a) < _rank(b)
    scale = max(a.scale, b.scale)
    left: int = _signed(a) * 10 ** (scale - a.scale)
    right: int = _signed(b) * 10 ** (scale - b.scale)
    return left < right


def _reads_as(text: str, spec: SeqFormat, last: SeqNumber) -> bool:
    """Whether a printed number reads back as LAST.

    GNU cuts the format's own text from both ends and reads the rest
    with strtold, so a number padded on the right never reads back.

    Args:
        text (str): the number as printed.
        spec (SeqFormat): the format it was printed with.
        last (SeqNumber): LAST.
    """
    head = len(spec.prefix.replace("%%", "%"))
    tail = len(spec.suffix.replace("%%", "%"))
    found = strtod_whole(text[head : len(text) - tail])
    value = None if found is None else read_number(found)
    if value is None or value.kind is NumberKind.NAN:
        return False
    return not _less(value, last) and not _less(last, value)


def _values(first: SeqNumber, step: SeqNumber) -> Iterator[SeqNumber]:
    """FIRST + i * INCREMENT for i from 1 on, without end.

    Exact sums for finite numbers; with an infinity in either, the sum
    is the same for every i, and a NaN when they are opposite.

    Args:
        first (SeqNumber): FIRST.
        step (SeqNumber): INCREMENT, never zero.
    """
    if first.kind is NumberKind.FINITE and step.kind is NumberKind.FINITE:
        scale = max(first.scale, step.scale)
        units = _signed(first) * 10 ** (scale - first.scale)
        delta = _signed(step) * 10 ** (scale - step.scale)
        while True:
            units += delta
            yield SeqNumber(units < 0, abs(units), scale)
    tail = first
    if first.kind is NumberKind.FINITE:
        tail = step
    elif step.kind is NumberKind.INFINITE and step.negative != first.negative:
        tail = SeqNumber(False, kind=NumberKind.NAN)
    while True:
        yield tail


def _integers(
    first: SeqNumber, step: SeqNumber, last: SeqNumber
) -> Iterator[str]:
    """The whole numbers after FIRST, printed plainly: GNU's seq_fast.

    Their digits are exact, so the number past LAST never reads back as
    LAST and the print loop's last test has nothing to add.

    Args:
        first (SeqNumber): FIRST, a whole number.
        step (SeqNumber): INCREMENT, a whole number.
        last (SeqNumber): LAST, which FIRST does not pass.
    """
    delta = _signed(step)
    start = _signed(first) + delta
    if last.kind is NumberKind.INFINITE:
        return map(digits_of_int, itertools.count(start, delta))
    whole, rest = divmod(_signed(last), 10**last.scale)
    if delta < 0 and rest:
        whole += 1
    return map(
        digits_of_int, range(start, whole + (1 if delta > 0 else -1), delta)
    )


def _lines(
    first: SeqNumber, step: SeqNumber, last: SeqNumber, spec: SeqFormat
) -> Iterator[str]:
    """GNU seq's print_numbers: each number as printed, FIRST to LAST.

    The number past LAST is printed too when it reads back as LAST and
    prints differently from the one before it. GNU added that against
    rounding in its long double sums; exact sums reach it only through a
    format with fewer digits than the operands (``seq -f %.1f 0 0.34 1``
    ends in 1.0).

    Args:
        first (SeqNumber): FIRST.
        step (SeqNumber): INCREMENT.
        last (SeqNumber): LAST.
        spec (SeqFormat): the format each number prints with.
    """
    descending = step.negative

    def past(value: SeqNumber) -> bool:
        return _less(value, last) if descending else _less(last, value)

    if past(first):
        return
    previous = render(spec, first)
    yield previous
    if (
        spec == PLAIN
        and first.kind is step.kind is NumberKind.FINITE
        and first.scale == step.scale == 0
    ):
        yield from _integers(first, step, last)
        return
    for value in _values(first, step):
        text = render(spec, value)
        if past(value):
            if text != previous and _reads_as(text, spec, last):
                yield text
            return
        yield text
        previous = text


async def _stream(
    lines: Iterator[str], separator: str
) -> AsyncIterator[bytes]:
    """The lines joined by SEPARATOR and ended by a newline, chunk by chunk.

    Nothing at all when there is no line. The chunks are lazy, so an
    endless sequence (``seq inf``) stops when the reader stops.

    Args:
        lines (Iterator[str]): the numbers as printed.
        separator (str): what goes between two of them.
    """
    budget = YieldBudget()
    batch: list[str] = []
    size = 0
    started = False
    for line in lines:
        batch.append(line)
        size += len(line) + len(separator)
        if size >= OUTPUT_CHUNK:
            lead = separator if started else ""
            yield encode_text(lead + separator.join(batch))
            started, batch, size = True, [], 0
            await budget.run()
    if batch:
        lead = separator if started else ""
        yield encode_text(lead + separator.join(batch) + "\n")
    elif started:
        yield b"\n"


@command("seq", vfs=None, spec=SPECS["seq"])
async def seq(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["seq"])
    if not texts:
        raise missing_operand_error(CommandName.SEQ, None)
    if len(texts) > 3:
        raise extra_operand_error(CommandName.SEQ, texts[3])
    typed = fl.as_str("format")
    equal_width = fl.as_bool("equal_width")
    spec = None if typed is None else parse_format(typed)
    if spec is not None and equal_width:
        raise _refuse(
            "format string may not be specified"
            " when printing equal width strings"
        )
    last = scan_operand(texts[0])
    first = step = ONE
    if len(texts) > 1:
        first, last = last, scan_operand(texts[1])
    if len(texts) > 2:
        step = last
        if step.value.kind is NumberKind.FINITE and not step.value.units:
            raise _refuse(
                f"invalid Zero increment value: '{quote_text(texts[1])}'"
            )
        last = scan_operand(texts[2])
    if spec is None:
        spec = default_format(first, step, last, equal_width)
    separator = fl.as_str("separator")
    lines = _lines(first.value, step.value, last.value, spec)
    return _stream(lines, "\n" if separator is None else separator), IOResult()
