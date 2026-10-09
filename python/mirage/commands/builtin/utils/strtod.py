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

# The binary128 long double strtold rounds to: a value from 2**16384 -
# 2**16270 up (LDBL_MAX plus half its ulp, a tie rounding to the even
# infinity) overflows, one under 2**-16382 is tiny, and a tiny one is held
# exactly only on the subnormal grid of 2**-16494.
_OVERFLOW = ((1 << 114) - 1) << 16270

# The leading digits that settle the range exactly, the rest only saying
# whether anything nonzero was dropped. 32 hex digits hold the 113 bits a
# long double keeps and more. In decimal the overflow edge is an integer
# of 4,933 digits, and a tiny value needs at most 11,563 digits past its
# lead to land on the grid or to be compared with the least normal one,
# so 12,000 settle both.
_HEX_KEPT = 32
_DECIMAL_KEPT = 12000


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


def _saturated(power: str) -> int:
    """An exponent as typed, held to 10**9 either way.

    Past that bound it cannot change whether a value is in range, and
    holding it keeps a thousands-digit exponent from reaching ``int``.

    Args:
        power (str): the exponent's digits after ``e`` or ``p``, signed.
    """
    digits = power.lstrip("+-").lstrip("0")
    value = 10**9 if len(digits) > 9 else int(digits or "0")
    return -value if power.startswith("-") else value


def strtold_erange(found: re.Match[str]) -> bool:
    """Whether strtold reports ERANGE for a STRTOD match.

    It does when the value rounds past the largest finite long double,
    and when a nonzero value under the least normal one cannot be held
    exactly: tininess is judged before rounding, so a value that rounds
    up to the least normal one is still out of range. An infinity or nan
    as typed is no error. The long double is binary128, as on arm64;
    x86-64's 80-bit format has the same exponent range. Only the leading
    digits that settle the answer are read into numbers, so the cost
    stays bounded however long the argument is.

    Args:
        found (re.Match[str]): a STRTOD match.
    """
    _, hexa, decimal, _, _ = found.groups()
    if hexa is not None:
        mantissa, _, power = hexa[2:].lower().partition("p")
        whole, _, fraction = mantissa.partition(".")
        digits = (whole + fraction).lstrip("0")
        if not digits:
            return False
        exponent = _saturated(power) - 4 * len(fraction)
        lead = int(digits[0], 16).bit_length()
        top = 4 * len(digits) - 5 + lead + exponent
        if -16382 <= top < 16383:
            return False
        if top >= 16384 or top < -16495:
            return True
        kept = digits[:_HEX_KEPT]
        dropped = digits[_HEX_KEPT:].strip("0") != ""
        significand = int(kept, 16)
        exponent += 4 * (len(digits) - len(kept))
        base = 2
    elif decimal is not None:
        mantissa, _, power = decimal.lower().partition("e")
        whole, _, fraction = mantissa.partition(".")
        joined = whole + fraction
        digits = joined.lstrip("0").rstrip("0")
        if not digits:
            return False
        # The value is 0.DIGITS x 10**scale.
        zeros = len(joined) - len(joined.lstrip("0"))
        scale = len(whole) - zeros + _saturated(power)
        if -4930 <= scale <= 4932:
            return False
        if scale >= 4934 or scale <= -4966:
            return True
        kept = digits[:_DECIMAL_KEPT]
        dropped = len(digits) > len(kept)
        significand = 0
        for at in range(0, len(kept), 4000):
            piece = kept[at : at + 4000]
            significand = significand * 10 ** len(piece) + int(piece)
        exponent = scale - len(kept)
        base = 10
    else:
        return False
    num: int = significand * base ** max(exponent, 0)
    den: int = base ** max(-exponent, 0)
    if num >= _OVERFLOW * den:
        return True
    return (num << 16382) < den and (dropped or (num << 16494) % den != 0)
