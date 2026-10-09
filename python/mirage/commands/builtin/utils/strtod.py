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
import re

# The number glibc's strtod reads in the C locale, and strtold with it:
# blanks (isspace, so CR and TAB count), a sign, then a hex float, a
# decimal float, inf or infinity, or nan with an optional (chars) tag,
# any case. The groups are the sign, the hex float, the decimal float,
# inf and nan. A match is the longest number at the front of a word,
# which is what strtod consumes; a GNU tool that reads its value through
# xstrtod refuses any leftover, trailing blanks included, so it needs a
# whole-word match (`tail -s $'1\r'` is an invalid number of seconds).
STRTOD = re.compile(
    r"[ \t\n\v\f\r]*([+-]?)(?:"
    r"(0[xX](?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)"
    r"(?:[pP][+-]?[0-9]+)?)"
    r"|((?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)"
    r"|([iI][nN][fF](?:[iI][nN][iI][tT][yY])?)"
    r"|([nN][aA][nN](?:\([0-9A-Za-z_]*\))?))"
)

# The binary128 long double strtold rounds to, written 0.DIGITS x 10**EXP:
# the largest finite value and the least normal one.
_LDBL_MAX = (4933, "118973149535723176508575932662800702")
_LDBL_MIN = (-4931, "336210314311209350626267781732175260")


def strtod_whole(text: str) -> re.Match[str] | None:
    """A STRTOD match spanning the whole word, as xstrtod demands, or None.

    Args:
        text (str): the word as typed.
    """
    return STRTOD.fullmatch(text)


def _hex_double(text: str) -> float:
    """A hex float such as 0x1.8p3 as the nearest double, inf past it.

    Args:
        text (str): the hex float as typed.
    """
    try:
        return float.fromhex(text)
    except OverflowError:
        return math.inf


def strtod_double(found: re.Match[str]) -> float:
    """The double strtod returns for a STRTOD match.

    The value is rounded once to the nearest double, ties to even, a
    magnitude past the range reads as an infinity, and every spelling of
    nan is the one quiet NaN.

    Args:
        found (re.Match[str]): a STRTOD match.
    """
    sign, hexa, decimal, inf, nan = found.groups()
    if nan is not None:
        return math.nan
    if inf is not None:
        value = math.inf
    elif hexa is not None:
        value = _hex_double(hexa)
    else:
        value = float(decimal)
    return -value if sign == "-" else value


def strtold_erange(found: re.Match[str]) -> bool:
    """Whether strtold reports ERANGE for a STRTOD match.

    It does past the largest finite long double, and for a nonzero value
    under the least normal one that it cannot hold exactly: a decimal
    never lands on the binary grid there, while a hex float does unless
    it has a bit below 2**-16494. An infinity or nan as typed is no error.
    The long double is binary128, as on arm64; x86-64's 80-bit format
    has the same exponent range.

    Args:
        found (re.Match[str]): a STRTOD match.
    """
    _, hexa, decimal, _, _ = found.groups()
    if hexa is not None:
        mantissa, _, power = hexa[2:].lower().partition("p")
        whole, _, fraction = mantissa.partition(".")
        digits = int(whole + fraction or "0", 16)
        if digits == 0:
            return False
        exponent = int(power or "0") - 4 * len(fraction)
        top = digits.bit_length() - 1 + exponent
        low = (digits & -digits).bit_length() - 1 + exponent
        return top >= 16384 or (top < -16382 and low < -16494)
    if decimal is None:
        return False
    mantissa, _, power = decimal.lower().partition("e")
    whole, _, fraction = mantissa.partition(".")
    joined = whole + fraction
    digits = joined.lstrip("0").rstrip("0")
    if not digits:
        return False
    # Both sides are 0.DIGITS x 10**EXP with a nonzero lead digit and no
    # trailing zero, so equal exponents order by the digits as text.
    zeros = len(joined) - len(joined.lstrip("0"))
    scaled = (len(whole) - zeros + int(power or "0"), digits)
    return scaled > _LDBL_MAX or scaled < _LDBL_MIN
