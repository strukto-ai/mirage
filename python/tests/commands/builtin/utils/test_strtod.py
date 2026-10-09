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
from decimal import Decimal, localcontext

import pytest

from mirage.commands.builtin.utils.strtod import (
    STRTOD,
    strtod_double,
    strtod_whole,
    strtold_erange,
)


def _double(text: str) -> float:
    found = STRTOD.match(text)
    assert found is not None
    return strtod_double(found)


# What glibc's strtod consumes at the front of a word, C locale. Mirrored
# in strtod.test.ts.
@pytest.mark.parametrize(
    "text,consumed",
    [
        ("  -1.5e3x", "  -1.5e3"),
        ("0x1.8p3 rest", "0x1.8p3"),
        ("0x", "0"),
        ("0x.p1", "0"),
        ("1e", "1"),
        ("1e+", "1"),
        (".5", ".5"),
        ("5.", "5."),
        ("INFINITY!", "INFINITY"),
        ("infinit", "inf"),
        ("nan(x_1)", "nan(x_1)"),
        ("nan(", "nan"),
        ("\t\r\v+3", "\t\r\v+3"),
        ("+.e1", None),
        ("", None),
        ("x1", None),
    ],
)
def test_strtod_reads_the_longest_number_at_the_front(text, consumed):
    found = STRTOD.match(text)
    assert (None if found is None else found.group(0)) == consumed


@pytest.mark.parametrize(
    "text,whole",
    [
        ("3", True),
        (" 3", True),
        ("0x10", True),
        ("3 ", False),
        ("1\r", False),
        ("1.5.2", False),
        ("", False),
    ],
)
def test_strtod_whole_refuses_any_leftover(text, whole):
    assert (strtod_whole(text) is not None) is whole


@pytest.mark.parametrize(
    "text,value",
    [
        ("1.5", 1.5),
        ("-0x1.8p1", -3.0),
        ("0x1p-1074", 5e-324),
        ("0x1p1024", math.inf),
        ("-0x1p1024", -math.inf),
        ("1e400", math.inf),
        ("-inf", -math.inf),
        ("Infinity", math.inf),
    ],
)
def test_strtod_double_rounds_once_to_the_nearest_double(text, value):
    assert _double(text) == value


@pytest.mark.parametrize("text", ["nan", "-NaN", "nan(0x1)"])
def test_every_nan_spelling_is_one_quiet_nan(text):
    value = _double(text)
    assert math.isnan(value)
    assert math.copysign(1.0, value) == 1.0


# 2**-16400 spelled out in decimal, all 11,463 significant digits: a
# subnormal the long double holds exactly.
with localcontext() as _context:
    _context.prec = 20000
    _EXACT_SUBNORMAL = format(Decimal(1) / Decimal(2) ** 16400, "e")


# Where glibc's strtold reports ERANGE for a binary128 long double, pinned
# with bash 5.2.37's printf: when the value rounds past the largest finite
# one, and when it is under the least normal one and off the subnormal
# grid, judged before rounding. Mirrored in strtod.test.ts.
@pytest.mark.parametrize(
    "text,erange",
    [
        ("1e400", False),
        ("1.1e4932", False),
        ("1.2e4932", True),
        ("4e-4932", False),
        ("3e-4932", True),
        ("1e-4970", True),
        ("0e99999", False),
        ("0x1.8p16383", False),
        ("0x1p99999", True),
        ("0x1p-16400", False),
        ("-inf", False),
        ("1.18973149535723176508575932662800703e4932", False),
        ("1.18973149535723176508575932662800708e4932", True),
        ("0x1.fffffffffffffffffffffffffffffp16383", True),
        ("0x1.ffffffffffffffffffffffffffff8p16383", True),
        ("3.3621031431120935062626778173217525e-4932", True),
        ("1e" + "9" * 5000, True),
        ("1e" + "0" * 5000 + "1", False),
        (_EXACT_SUBNORMAL, False),
        ("1" * 20000 + "e-15067", False),
        (
            "3.3621031431120935062626778173217526" + "0" * 20000 + "1e-4932",
            True,
        ),
        ("0x1." + "f" * 20000 + "p16383", True),
    ],
)
def test_strtold_erange_marks_what_a_long_double_cannot_hold(text, erange):
    found = STRTOD.match(text)
    assert found is not None
    assert strtold_erange(found) is erange
