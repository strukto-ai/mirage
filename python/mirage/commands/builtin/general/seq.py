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
import re
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from enum import Enum
from typing import NamedTuple

from mirage.accessor.base import Accessor
from mirage.commands.builtin.general.expr import digits_of_int, int_of_digits
from mirage.commands.builtin.utils.strtod import (
    LONG_DOUBLE_OVERFLOW,
    strtod_whole,
)
from mirage.commands.config import Context, command
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

# What GNU seq takes for -f: one floating directive, its flags and an
# optional L, with nothing but %% around it.
FORMAT_DIRECTIVE = re.compile(r"([-+#0 ']*)([0-9]*)(?:\.([0-9]*))?(L?)")
FLOAT_CONVERSIONS = "efgaEFGA"

# GNU's long double, as the pins here measure it: IEEE binary128, arm64
# Linux's, with 112 fraction bits under the lead bit and a least normal
# exponent of -16382. GNU's own output depends on it: x86-64's 80-bit
# long double keeps 64 bits with an explicit lead bit, so its %a prints 1
# as 0x8p-3 where arm64 prints 0x1p+0, and its overflow edge sits lower.
# No one output matches both; mirage follows binary128 throughout, the
# form seq's %a goldens were pinned in.
QUAD_FRACTION_BITS = 112
QUAD_MIN_EXPONENT = -16382

# strtold reads zero for a magnitude at or under 2**-UNDERFLOW_BITS, half
# of the least subnormal, and GNU takes the zero.
UNDERFLOW_BITS = 16495

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
    """An operand as seq reads it.

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

# The default format for whole numbers, ``%.0f``, which needs no printf
# for a whole FIRST and INCREMENT.
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
    under 10**-4966 it is zero, as are 2**16384 and 2**-16495 for a hex
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
        if top < -4965:
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
        if top < -16494:
            return SeqNumber(negative)
        shift = min((bits & -bits).bit_length() - 1, max(-exponent, 0))
        bits >>= shift
        exponent += shift
        if exponent >= 0:
            return _in_range(negative, bits << exponent, 0)
        return _in_range(negative, bits * 5**-exponent, -exponent)
    return SeqNumber(negative, kind=NumberKind.NAN)


def _typed_shape(found: re.Match[str]) -> tuple[int, int | None]:
    """The print width and decimals of an operand, from how it was typed.

    The integer digits count as typed, leading zeros and all (`001` is
    three wide), with one for a `-` and none for a `+` or a blank, and
    `.5` counts as `0.5`. An exponent moves the point: a positive one
    widens the integer part (`0.5e1` is `05`, two wide) and eats the
    decimals, a negative one adds decimals and leaves the integer part
    alone (`12e-1` is `01.2`). Measured on GNU 9.7 over 3,600 operand
    pairs, with and without `-w`.

    Args:
        found (re.Match[str]): the operand's whole-word STRTOD match.

    Returns:
        tuple[int, int | None]: the width, 0 for a hex number or an
            infinity, and the decimals, None when GNU prints the
            operand with `%g`: a hex float with a point or a lowercase
            `p` exponent (`0x1P3` keeps fixed point, `0x1p3` does not).
    """
    sign, hexa, decimal, _inf, _nan = found.groups()
    if hexa is not None:
        return 0, None if "." in hexa or "p" in hexa else 0
    if decimal is None:
        return 0, 0
    mantissa, _, power = decimal.lower().partition("e")
    whole, _, fraction = mantissa.partition(".")
    shift = _signed_digits(power or "0")
    decimals = max(len(fraction) - shift, 0)
    width = (sign == "-") + max(len(whole), 1) + max(shift, 0)
    return width + (decimals + 1 if decimals else 0), decimals


def read_operand(text: str) -> SeqOperand:
    """FIRST, INCREMENT or LAST, refused as GNU refuses it.

    The whole word must be one number in strtold's syntax, leading
    blanks allowed and trailing ones not (`seq '3 '` is refused), and
    within the long double range. NaN is refused in words of its own.

    Args:
        text (str): the operand as typed.

    Raises:
        UsageError: GNU's refusal and the `Try` hint, exit 1.
    """
    shown = f"'{quote_text(text)}'"
    found = strtod_whole(text)
    value = None if found is None else read_number(found)
    if found is None or value is None:
        raise _refuse(f"invalid floating point argument: {shown}")
    if value.kind is NumberKind.NAN:
        raise _refuse(f"invalid 'not-a-number' argument: {shown}")
    width, decimals = _typed_shape(found)
    return SeqOperand(value, width, decimals)


def _width_at(operand: SeqOperand, decimals: int) -> int:
    """An operand's width once printed with ``decimals`` places.

    Its integer part keeps its typed width and the decimals are what the
    format asks for: `-w .5 -0.25 -.5` prints `-.5` as `-0.50`, five
    wide. A hex number or an infinity has no integer part to count but
    still takes the point and the decimals: `seq -w inf 0.001 inf`
    prints ` inf`, four wide.

    Args:
        operand (SeqOperand): FIRST or LAST, one with decimals.
        decimals (int): the places the format prints.
    """
    typed = operand.precision or 0
    integer = operand.width - (typed + 1 if typed else 0)
    return integer + (decimals + 1 if decimals else 0)


def implied_format(
    first: SeqOperand,
    step: SeqOperand,
    last: SeqOperand,
    equal_width: bool,
) -> SeqFormat:
    """The format seq prints with when no ``-f`` is given.

    ``%.Nf``, where N is the most decimals FIRST or INCREMENT was typed
    with (LAST's never count: `seq 1 1.50` prints `1`). ``-w`` pads it
    with zeros to the wider of FIRST and LAST at those decimals, and
    INCREMENT's width never counts (`seq -w 1 10 5` prints `1`). Any
    operand ``%g`` would print turns the whole format into ``%g``,
    which ``-w`` leaves unpadded (`seq -w 1 0x1.8 5` prints `2.5`).

    Args:
        first (SeqOperand): FIRST.
        step (SeqOperand): INCREMENT.
        last (SeqOperand): LAST.
        equal_width (bool): ``-w`` was given.
    """
    if None in (first.precision, step.precision, last.precision):
        return SeqFormat("", "", "", None, "g", "")
    decimals = max(first.precision or 0, step.precision or 0)
    if not equal_width:
        return SeqFormat("", "", "", str(decimals), "f", "")
    width = max(_width_at(first, decimals), _width_at(last, decimals))
    return SeqFormat("", "0", str(width), str(decimals), "f", "")


def _nearest(numerator: int, denominator: int) -> int:
    """``numerator / denominator`` rounded half to even.

    Args:
        numerator (int): a dividend, not negative.
        denominator (int): a divisor, positive.
    """
    kept, rest = divmod(numerator, denominator)
    if 2 * rest > denominator or (2 * rest == denominator and kept % 2):
        kept += 1
    return kept


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
    return _nearest(units, unit)


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


def _sign_text(value: SeqNumber, flags: str) -> str:
    """The sign printf writes ahead of a number: ``-``, or what ``+`` or a
    space flag asks for a positive one.

    Args:
        value (SeqNumber): the number.
        flags (str): the directive's flags.
    """
    if value.negative:
        return "-"
    return "+" if "+" in flags else " " if " " in flags else ""


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
    sign = _sign_text(value, flags)
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


def _quad_digits(value: SeqNumber) -> tuple[str, str, int]:
    """A finite number as a binary128 long double holds it, in hex.

    The value rounds half to even to 113 significant bits, or to the
    subnormal grid under 2**-16382, which glibc writes with a lead digit
    of 0 and that least exponent (``0x0.00004p-16382``).

    Args:
        value (SeqNumber): a finite number.

    Returns:
        tuple[str, str, int]: the lead hex digit, the 28 fraction digits
            and the binary exponent.
    """
    places = QUAD_FRACTION_BITS // 4
    denominator: int = 10**value.scale
    exponent = value.units.bit_length() - denominator.bit_length()
    if value.units << max(-exponent, 0) < denominator << max(exponent, 0):
        exponent -= 1
    exponent = max(exponent, QUAD_MIN_EXPONENT)
    shift = QUAD_FRACTION_BITS - exponent
    mantissa = (
        _nearest(value.units << shift, denominator)
        if shift >= 0
        else _nearest(value.units, denominator << -shift)
    )
    if not mantissa:
        return "0", "0" * places, 0
    if mantissa >> (QUAD_FRACTION_BITS + 1):
        mantissa >>= 1
        exponent += 1
    fraction = mantissa & ((1 << QUAD_FRACTION_BITS) - 1)
    lead = mantissa >> QUAD_FRACTION_BITS
    return f"{lead:x}", f"{fraction:0{places}x}", exponent


def _hex_float(value: SeqNumber, spec: SeqFormat) -> str:
    """``value`` through a ``%a`` directive, as glibc renders it.

    The value is the binary128 long double nearest it. The hex digits
    round half to even at the precision without renormalizing (``%.0a``
    of 3 is ``0x2p+1``), ``#`` keeps the point and ``0`` pads after
    ``0x``. GNU sums in long double while these sums are exact, so a
    printed sum can differ in its last bit (``seq -f %a 0.1 0.1 0.3``
    stops after 0.2 in GNU, whose third sum overshoots 0.3).

    Args:
        value (SeqNumber): the number to print.
        spec (SeqFormat): the parsed format.
    """
    flags = spec.flags
    sign = _sign_text(value, flags)
    zero = False
    if value.kind is not NumberKind.FINITE:
        body = "nan" if value.kind is NumberKind.NAN else "inf"
    else:
        lead, digits, exponent = (
            _quad_digits(value) if value.units else ("0", "", 0)
        )
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
        body = f"0x{lead}{point}{digits}p{exponent:+d}"
        zero = "0" in flags and "-" not in flags
    if spec.conversion == "A":
        body = body.upper()
    width = int(spec.width or "0")
    if "-" in flags:
        return (sign + body).ljust(width)
    if zero:
        return sign + body[:2] + body[2:].rjust(width - len(sign) - 2, "0")
    return (sign + body).rjust(width)


def render(spec: SeqFormat, value: SeqNumber) -> str:
    """One number through a seq format, as C's printf renders it.

    Args:
        spec (SeqFormat): the parsed format.
        value (SeqNumber): the number to print.
    """
    if spec.conversion in "aA":
        body = _hex_float(value, spec)
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
    """The whole numbers after FIRST, printed plainly.

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


def _names_last(text: str, spec: SeqFormat, last: SeqNumber) -> bool:
    """Whether a printed number, read back as a number, is LAST.

    The format's own text is cut from both ends and strtold reads what
    is left as a whole word, so leading blanks read (`%5.1f`) and
    trailing ones do not: `seq -f %-5.1f 0 0.34 1` stops at `0.7`
    where `seq -f %5.1f 0 0.34 1` goes on to `  1.0`.

    Args:
        text (str): one number as the format printed it.
        spec (SeqFormat): the format.
        last (SeqNumber): LAST.
    """
    lead = len(spec.prefix.replace("%%", "%"))
    tail = len(spec.suffix.replace("%%", "%"))
    found = strtod_whole(text[lead : len(text) - tail])
    value = None if found is None else read_number(found)
    if value is None or value.kind is not last.kind:
        return False
    if value.kind is NumberKind.INFINITE:
        return value.negative == last.negative
    if value.kind is NumberKind.NAN:
        return False
    scale = max(value.scale, last.scale)
    read: int = _signed(value) * 10 ** (scale - value.scale)
    wanted: int = _signed(last) * 10 ** (scale - last.scale)
    return read == wanted


def _zero_pad(spec: SeqFormat) -> int | None:
    """The width a ``%.0f``-shaped format zero-pads whole numbers to.

    None for any other format; 0 for the plain ``%.0f`` itself.

    Args:
        spec (SeqFormat): the format.
    """
    plain = PLAIN.prefix == spec.prefix and PLAIN.suffix == spec.suffix
    if not plain or spec.conversion != "f" or spec.precision != "0":
        return None
    if spec.flags == "":
        return None if spec.width else 0
    return int(spec.width or "0") if spec.flags == "0" else None


def _whole(value: SeqNumber) -> bool:
    """A finite number with nothing after the point.

    Args:
        value (SeqNumber): the number.
    """
    return (
        value.kind is NumberKind.FINITE and not value.units % 10**value.scale
    )


def _printed_lines(
    first: SeqNumber, step: SeqNumber, last: SeqNumber, spec: SeqFormat
) -> Iterator[str]:
    """Each number of the sequence as printed, FIRST to LAST.

    Nothing when FIRST is already past LAST. Otherwise the numbers up to
    LAST, and then the first one past it as well when it prints
    differently from the one before it and its printed text reads back
    as LAST: `seq -f %.1f 0 0.34 1` ends in `1.0`, the 1.02 past LAST,
    while `seq -f %.0f 0 0.6 1` stops at the `1` 0.6 printed as. Sums
    are exact, so a whole FIRST and INCREMENT under a whole-number
    format can skip printf.

    Args:
        first (SeqNumber): FIRST.
        step (SeqNumber): INCREMENT, never zero or a NaN.
        last (SeqNumber): LAST, never a NaN.
        spec (SeqFormat): the format.
    """

    def beyond(value: SeqNumber) -> bool:
        return _less(value, last) if step.negative else _less(last, value)

    if beyond(first):
        return
    shown = render(spec, first)
    yield shown
    pad = _zero_pad(spec)
    if pad is not None and _whole(first) and _whole(step):
        for digits in _integers(first, step, last):
            if not pad:
                yield digits
            elif digits.startswith("-"):
                yield "-" + digits[1:].rjust(pad - 1, "0")
            else:
                yield digits.rjust(pad, "0")
        return
    for value in _values(first, step):
        text = render(spec, value)
        if beyond(value):
            if text != shown and _names_last(text, spec, last):
                yield text
            return
        yield text
        shown = text


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
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, spec=SPECS["seq"])
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
    last = read_operand(texts[0])
    first = step = ONE
    if len(texts) > 1:
        first, last = last, read_operand(texts[1])
    if len(texts) > 2:
        step = last
        if step.value.kind is NumberKind.FINITE and not step.value.units:
            raise _refuse(
                f"invalid Zero increment value: '{quote_text(texts[1])}'"
            )
        last = read_operand(texts[2])
    if spec is None:
        spec = implied_format(first, step, last, equal_width)
    separator = fl.as_str("separator")
    lines = _printed_lines(first.value, step.value, last.value, spec)
    return _stream(lines, "\n" if separator is None else separator), IOResult()
