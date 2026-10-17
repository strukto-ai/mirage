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

import re

from mirage.commands.builtin.constants import C_SPACE
from mirage.commands.builtin.utils.size_suffix import (
    decimal_value,
    parse_base0,
)

# gnulib's xstrtoimax/xstrtoumax at base 10 with no suffix: C blanks, one
# sign, ASCII digits, and nothing after them, not even a blank.
DECIMAL = re.compile(rf"{C_SPACE}([+-]?)([0-9]+)")
# C's strto(u)l at base 0: C blanks, one sign, then hex after 0x, octal
# after a bare 0, decimal otherwise; the text after the digits is left.
BASE0 = re.compile(rf"{C_SPACE}([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)")
LONG_MIN = -(2**63)
LONG_MAX = 2**63 - 1
ULONG_MAX = 2**64 - 1
INT_MAX = 2**31 - 1
UINT_MAX = 2**32 - 1
# What gnulib appends after a refused number that scanned, measured under
# LC_ALL=C on glibc: ERANGE for a value outside the option's range and
# EOVERFLOW for one the program words as too large for its type.
ERANGE_REASON = "Numerical result out of range"
EOVERFLOW_REASON = "Value too large for defined data type"


def xstrtoumax(text: str) -> int | None:
    """``text`` as gnulib's ``xstrtoumax`` reads a decimal operand.

    A minus, any other byte, or a blank after the digits makes it no
    number. The value is exact, so a caller's range check also catches
    one that overflows ``uintmax_t``.

    Args:
        text (str): the operand as typed.
    """
    match = DECIMAL.fullmatch(text)
    if match is None or match.group(1) == "-":
        return None
    return decimal_value(match.group(2))


def xstrtoimax(text: str) -> int | None:
    """``text`` as gnulib's ``xstrtoimax`` reads a decimal operand.

    Args:
        text (str): the operand as typed.
    """
    match = DECIMAL.fullmatch(text)
    if match is None:
        return None
    value = decimal_value(match.group(2))
    return -value if match.group(1) == "-" else value


def strtol(text: str) -> tuple[int, str]:
    """C's ``strtol(text, &end, 0)``: the value and the text at ``end``.

    No number is 0 with the whole text left, and a value past the
    ``long`` range saturates, as glibc's does.

    Args:
        text (str): the operand as typed.
    """
    match = BASE0.match(text)
    if match is None:
        return 0, text
    value = parse_base0(match.group(2))
    signed = -value if match.group(1) == "-" else value
    return max(LONG_MIN, min(LONG_MAX, signed)), text[match.end() :]


def strtoul(text: str) -> tuple[int, str]:
    """C's ``strtoul(text, &end, 0)``: the value and the text at ``end``.

    A minus negates in unsigned arithmetic, so ``-1`` is ``ULONG_MAX``,
    and a value past ``ULONG_MAX`` saturates there.

    Args:
        text (str): the operand as typed.
    """
    match = BASE0.match(text)
    if match is None:
        return 0, text
    value = parse_base0(match.group(2))
    if value > ULONG_MAX:
        return ULONG_MAX, text[match.end() :]
    if match.group(1) == "-":
        value = -value % (ULONG_MAX + 1)
    return value, text[match.end() :]


def c_int(value: int) -> int:
    """``value`` as C's ``(int)`` cast leaves it: its low 32 bits, signed.

    Args:
        value (int): the wider integer.
    """
    return (value + 2**31) % 2**32 - 2**31


__all__ = [
    "EOVERFLOW_REASON",
    "ERANGE_REASON",
    "INT_MAX",
    "UINT_MAX",
    "ULONG_MAX",
    "c_int",
    "strtol",
    "strtoul",
    "xstrtoimax",
    "xstrtoumax",
]
