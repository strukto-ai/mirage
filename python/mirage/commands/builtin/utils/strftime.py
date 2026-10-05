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
from datetime import datetime

GNU_FLAG_CHARS = "-_0^#+"
# The conversions GNU date knows; any other stays literal, as in GNU.
GNU_DIRECTIVES = "aAbBcCdDeFgGhHIjklmMnNpPqrRsStTuUVwWxXyYzZ%"
GNU_PAD_FLAGS = "-_0+"
# The directives GNU's `+` flag signs, with the digits each shows before
# the sign becomes necessary; the two-digit years never outgrow theirs,
# so only a width signs them (%+3y is +26).
YEARISH_DIGITS = {"Y": 4, "G": 4, "C": 2, "y": 2, "g": 2}
# The numeric directives, with the digits each shows by default; a width
# typed on one replaces that default rather than adding to it.
NUMERIC_DIGITS = {
    "C": 2,
    "d": 2,
    "e": 2,
    "g": 2,
    "G": 4,
    "H": 2,
    "I": 2,
    "j": 3,
    "k": 2,
    "l": 2,
    "m": 2,
    "M": 2,
    "S": 2,
    "u": 1,
    "U": 2,
    "V": 2,
    "w": 1,
    "W": 2,
    "y": 2,
    "Y": 4,
}
# The numeric directives GNU fills with spaces rather than zeros.
SPACE_PADDED = "ekl"
# The directives that stand for several parts (%F is %+4Y-%m-%d, %D is
# %m/%d/%y, %T is %H:%M:%S), which GNU pads as a whole.
COMPOSITES = "cDFrRTxX"
# The directives that render text (names, AM/PM, the zone abbreviation)
# or a blank, whose width GNU fills with spaces unless `0` or `+` says
# zeros and whose `-` drops it; glibc pads them under `-` anyway.
TEXTUAL = "aAbBhnpPtZ"


def winning_pad(flags: str) -> str | None:
    """The padding flag GNU applies: the last of ``-``, ``_``, ``0`` and
    ``+`` typed (``%_-2q`` is ``3``, ``%-_2q`` is ``" 3"``), None when
    none was.

    Args:
        flags (str): the flag characters typed between ``%`` and the
            width.
    """
    pad = None
    for ch in flags:
        if ch in GNU_PAD_FLAGS:
            pad = ch
    return pad


def pad_signed(
    sign: str, digits: str, pad: str | None, width: int | None
) -> str:
    """Pad a signed number the way GNU date pads one: zeros go after the
    sign (``%3s`` of -1 is ``-01``, ``%8:z`` is ``+0005:30``), spaces
    before it (``%_3s`` is ``" -1"``), and ``-`` pads nothing.

    Args:
        sign (str): ``-``, ``+`` or empty.
        digits (str): the magnitude.
        pad (str | None): the winning padding flag, None for a bare width.
        width (int | None): the width the digits fill, None for none.
    """
    if pad == "-" or width is None or width <= len(digits):
        return sign + digits
    if pad == "_":
        return " " * (width - len(digits)) + sign + digits
    return sign + digits.rjust(width, "0")


def zone_offset(
    dt: datetime, colons: int, flags: str, width: int | None
) -> str:
    """Render ``%z`` and its colon forms as GNU date does: ``%:z`` is
    ``+05:30``, ``%::z`` adds seconds, ``%:::z`` keeps only the parts
    that are not zero (``+05``, ``+05:30``). Under a colon the flags and
    width pad the hours field with the width covering the whole
    (``%_:z`` is ``" +5:30"``, ``%8:z`` is ``+0005:30``, ``%-:z`` is
    ``+5:30``); the plain form is one ``hhmm`` number, so ``-`` and
    ``_`` reach its minutes too (``%-z`` is ``+530``, and ``+0`` in
    UTC; ``%_z`` is ``" +530"`` and ``"   +0"``). A naive moment is
    taken as local time, as ``%s`` takes it.

    Args:
        dt (datetime): the moment being rendered.
        colons (int): how many colons were typed before ``z``.
        flags (str): the flag characters typed between ``%`` and the
            width.
        width (int | None): the minimum field width, if typed.
    """
    offset = dt.utcoffset()
    if offset is None:
        offset = dt.astimezone().utcoffset()
    total = round(offset.total_seconds()) if offset is not None else 0
    sign = "-" if total < 0 else "+"
    hours, rest = divmod(abs(total), 3600)
    minutes, seconds = divmod(rest, 60)
    if colons == 0:
        digits = 4 if width is None else width - 1
        return pad_signed(
            sign, str(hours * 100 + minutes), winning_pad(flags), digits
        )
    if colons == 1 or (colons == 3 and minutes and not seconds):
        tail = f":{minutes:02d}"
    elif colons == 2 or seconds:
        tail = f":{minutes:02d}:{seconds:02d}"
    else:
        tail = ""
    digits = 2 if width is None else width - len(tail) - 1
    return pad_signed(sign, str(hours), winning_pad(flags), digits) + tail


def epoch_seconds(dt: datetime, flags: str, width: int | None) -> str:
    """Render ``%s`` as GNU date does, padding a negative value after
    its sign (``%3s`` of -1 is ``-01``, ``%_5s`` is ``"   -1"``).

    Args:
        dt (datetime): the moment being rendered.
        flags (str): the flag characters typed between ``%`` and the
            width.
        width (int | None): the minimum field width, if typed.
    """
    value = math.floor(dt.timestamp())
    sign = "-" if value < 0 else ""
    digits = None if width is None else width - len(sign)
    return pad_signed(sign, str(abs(value)), winning_pad(flags), digits)


def pad_number(
    dt: datetime, directive: str, flags: str, width: int | None
) -> str:
    """Render a numeric directive under GNU's flags and width: the width
    replaces the default digits rather than adding to them (``%1d`` is
    ``3``, ``%3d`` is ``003``), ``_`` pads with spaces and ``-`` with
    nothing, and a bare width pads with the directive's own filler,
    zeros everywhere but ``%e``, ``%k`` and ``%l`` (``%3e`` is
    ``"  3"``, ``%03e`` is ``003``).

    Args:
        dt (datetime): the moment being rendered.
        directive (str): the directive letter, a key of NUMERIC_DIGITS.
        flags (str): the flag characters typed between ``%`` and the
            width.
        width (int | None): the minimum field width, if typed.
    """
    value = int(dt.strftime("%" + directive))
    pad = winning_pad(flags)
    if pad is None:
        pad = "_" if directive in SPACE_PADDED else "0"
    digits = NUMERIC_DIGITS[directive] if width is None else width
    return pad_signed("", str(value), pad, digits)


def pad_quarter(quarter: str, flags: str, width: int | None) -> str:
    """Pad ``%q``'s digit the way GNU date pads a number.

    ``-`` drops the padding, ``_`` pads with spaces, ``0`` and ``+`` with
    zeros, and the last of them typed wins; a bare width zero-pads.

    Args:
        quarter (str): the quarter digit.
        flags (str): the flag characters typed between ``%`` and the
            width.
        width (int | None): the minimum field width, if typed.
    """
    pad = winning_pad(flags)
    if pad == "-" or width is None:
        return quarter
    return quarter.rjust(width, " " if pad == "_" else "0")


def padded_composite(
    dt: datetime, directive: str, flags: str, width: int | None
) -> str:
    """Pad a composite directive (``%F``, ``%D``, ``%T``, ``%c`` and the
    rest of ``COMPOSITES``) the way GNU date does: the flags reach the
    parts, so ``-``, ``_`` and ``0`` alone change nothing, ``^`` upcases
    the text, and a width pads the whole on the left, with spaces under
    a bare width or ``_`` and with zeros under ``0`` or ``+``
    (``%12D`` is ``"    09/03/26"``, ``%012D`` is ``000009/03/26``);
    ``-`` drops the padding. ``%F`` is ``%+4Y-%m-%d``, so there a bare,
    ``0`` or ``+`` width reaches the year instead (``%12F`` is
    ``002026-09-03``, ``%+12F`` is ``+02026-09-03``) while ``_`` still
    pads the whole with spaces.

    Args:
        dt (datetime): the moment being rendered.
        directive (str): one of ``COMPOSITES``.
        flags (str): the flag characters typed between ``%`` and the
            width.
        width (int | None): the minimum field width, if typed.
    """
    text = dt.strftime("%" + directive)
    if "^" in flags:
        text = text.upper()
    pad = winning_pad(flags)
    if width is None or pad == "-":
        return text
    if directive == "F" and pad != "_":
        rest = dt.strftime("-%m-%d")
        if pad == "+":
            return plus_year(dt, "Y", width - 6) + rest
        return pad_signed("", str(dt.year), "0", width - 6) + rest
    return text.rjust(width, "0" if pad in ("0", "+") else " ")


def plus_year(dt: datetime, directive: str, width: int | None) -> str:
    """Render ``%+Y``, ``%+G``, ``%+C``, ``%+y`` or ``%+g`` as GNU date
    does: zero-padded to the width, and led by ``+`` when the value
    outgrows the digits the directive normally shows or the width
    leaves room for a sign (``%+5Y`` is ``+2026``, ``%+4Y`` is ``2026``,
    ``%+6Y`` is ``+02026``, ``%+3C`` is ``+20``, ``%+3y`` is ``+26``,
    ``%+5y`` is ``+0026``).

    Args:
        dt (datetime): the moment being rendered.
        directive (str): a key of YEARISH_DIGITS.
        width (int | None): the minimum field width, if typed.
    """
    if directive == "Y":
        value = dt.year
    elif directive == "G":
        value = dt.isocalendar()[0]
    elif directive == "C":
        value = dt.year // 100
    elif directive == "y":
        value = dt.year % 100
    else:
        value = dt.isocalendar()[0] % 100
    digits = YEARISH_DIGITS[directive]
    signed = value > 10**digits - 1 or (width is not None and width > digits)
    sign = "+" if signed else ""
    return sign + str(value).rjust((width or 0) - len(sign), "0")


def meridiem(dt: datetime) -> str:
    """GNU's ``%P``: ``am`` or ``pm``, whatever the C library knows.

    Args:
        dt (datetime): the moment being rendered.
    """
    return "am" if dt.hour < 12 else "pm"


def pad_text(
    dt: datetime, directive: str, flags: str, width: int | None
) -> str:
    """Render a textual directive (one of ``TEXTUAL``) under GNU's flags
    and width: ``#`` lowers ``%p`` and ``%Z`` and uppers the day and
    month names, outranking ``^``, which uppers anything; a width pads
    on the left with spaces under a bare width or ``_`` and with zeros
    under ``0`` or ``+`` (``%5a`` is ``"  Thu"``, ``%05a`` is ``00Thu``),
    and ``-`` drops it (``%-5a`` is ``Thu``, where glibc pads anyway).

    Args:
        dt (datetime): the moment being rendered.
        directive (str): one of ``TEXTUAL``.
        flags (str): the flag characters typed between ``%`` and the
            width.
        width (int | None): the minimum field width, if typed.
    """
    text = meridiem(dt) if directive == "P" else dt.strftime("%" + directive)
    if "#" in flags:
        text = text.lower() if directive in "pZ" else text.upper()
    elif "^" in flags and directive != "P":
        text = text.upper()
    pad = winning_pad(flags)
    if width is None or pad == "-":
        return text
    return text.rjust(width, "0" if pad in ("0", "+") else " ")


def gnu_strftime(dt: datetime, fmt: str) -> str:
    """Render ``fmt`` the way GNU ``date`` and ``ls --time-style=+FMT`` do.

    Two directives GNU implements itself are expanded ahead of the C
    library's strftime, which would print them as mangled literals:
    ``%q`` (quarter) and ``%N`` (nanoseconds, from the microseconds a
    timestamp carries). Both take GNU's flag and width prefix
    (``%3N``, ``%_3N``, ``%2q``), pinned against date 9.7: a width on
    ``N`` keeps that many leading digits and pads wider widths with
    zeros on the right (``%3N`` is milliseconds, ``%12N`` appends three
    zeros) and its flags change nothing, while a width on ``q`` pads on
    the left under the padding flags (``%_2q`` is ``" 3"``, ``%-2q`` is
    ``3``). GNU's ``+`` flag is expanded here too, since the C library
    does not know it: on the year directives ``Y``, ``G``, ``C``, ``y``
    and ``g`` it signs the value (``plus_year``), and anywhere else it
    is ``0``, so ``%+5d`` reaches strftime as ``%05d``; a ``+`` that a
    later padding flag outranks is dropped. A composite directive
    (``%F``, ``%D``, ``%T``, ``%c`` and friends) that carries any flag
    or width is padded here as a whole (``padded_composite``), since the C
    libraries disagree with GNU and with each other about it (``%12F``
    is ``002026-09-03``, which glibc space-pads and macOS mangles).
    ``%z`` and its colon forms ``%:z``,
    ``%::z`` and ``%:::z`` are rendered here too (``zone_offset``), as
    is ``%s`` (``epoch_seconds``), since neither C library pads a
    negative number or an offset the way GNU does. A colon before any
    other directive stays literal, as in GNU. A numeric directive that
    carries a width or a padding flag is rendered here as well
    (``pad_number``), because GNU's width replaces the default digits
    where the C library's adds to them (``%1d`` is ``3``, not ``03``),
    and so is a textual one (``pad_text``), because glibc pads a name
    under ``-`` where GNU drops the width (``%-5a`` is ``Thu``). Every
    other directive passes to strftime with its prefix intact; ``%%``
    pairs are stepped over, keeping ``%%q`` literal.

    Args:
        dt (datetime): the moment being rendered.
        fmt (str): the format as typed, without the leading ``+``.
    """
    out: list[str] = []
    i = 0
    while i < len(fmt):
        if fmt[i] != "%":
            out.append(fmt[i])
            i += 1
            continue
        j = i + 1
        while j < len(fmt) and fmt[j] in GNU_FLAG_CHARS:
            j += 1
        k = j
        while k < len(fmt) and fmt[k].isdigit():
            k += 1
        c = k
        while c < len(fmt) and fmt[c] == ":":
            c += 1
        if c >= len(fmt):
            out.append("%%" + fmt[i + 1 :])
            break
        width = int(fmt[j:k]) if k > j else None
        flags = fmt[i + 1 : j]
        pad = winning_pad(flags)
        directive = fmt[c]
        if (
            c == k
            and directive in "EO"
            and fmt[c + 1 : c + 2] != ""
            and fmt[c + 1] in GNU_DIRECTIVES
        ):
            # The C locale has no alternative forms: a modified directive
            # is the plain one.
            out.append(
                gnu_strftime(dt, fmt[i:k] + fmt[c + 1]).replace("%", "%%")
            )
            i = c + 2
            continue
        if directive == "z":
            out.append(zone_offset(dt, c - k, flags, width))
        elif c > k:
            out.append("%%" + fmt[i + 1 : c + 1])
        elif directive == "s":
            out.append(epoch_seconds(dt, flags, width))
        elif directive == "q":
            quarter = str((dt.month - 1) // 3 + 1)
            out.append(pad_quarter(quarter, flags, width))
        elif directive == "N":
            nanos = f"{dt.microsecond * 1000:09d}"
            out.append(nanos[:width].ljust(width, "0") if width else nanos)
        elif pad == "+" and directive in YEARISH_DIGITS:
            out.append(plus_year(dt, directive, width))
        elif directive in COMPOSITES and (flags or width is not None):
            out.append(padded_composite(dt, directive, flags, width))
        elif directive in NUMERIC_DIGITS and (
            width is not None or pad is not None
        ):
            out.append(pad_number(dt, directive, flags, width))
        elif directive in TEXTUAL and (flags or width is not None):
            out.append(pad_text(dt, directive, flags, width))
        elif directive not in GNU_DIRECTIVES:
            out.append("%%" + fmt[i + 1 : c + 1])
        elif directive == "P":
            out.append(meridiem(dt))
        elif "+" in flags:
            zero = "0" if pad == "+" else ""
            out.append("%" + flags.replace("+", zero) + fmt[j : k + 1])
        else:
            out.append(fmt[i : k + 1])
        i = c + 1
    return dt.strftime("".join(out))
