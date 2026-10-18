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

import pytest

from mirage.commands.builtin.utils.strtol import (
    c_int,
    signed_decimal,
    strtol,
    strtoul,
    unsigned_decimal,
)


@pytest.mark.parametrize(
    "raw,value",
    [
        ("2", (2, "")),
        ("0x2", (2, "")),
        ("017", (15, "")),
        ("2k", (2, "k")),
        ("x", (0, "x")),
        ("08", (0, "8")),
        ("-3", (-3, "")),
        (" +4", (4, "")),
        ("99999999999999999999", (2**63 - 1, "")),
        ("-99999999999999999999", (-(2**63), "")),
    ],
)
def test_strtol_reads_base_zero_and_leaves_the_rest(raw, value):
    assert strtol(raw) == value


@pytest.mark.parametrize(
    "raw,value",
    [
        ("", (0, "")),
        ("0x10", (16, "")),
        ("-1", (2**64 - 1, "")),
        ("99999999999999999999", (2**64 - 1, "")),
        ("3x", (3, "x")),
        ("  ", (0, "  ")),
    ],
)
def test_strtoul_negates_unsigned_and_saturates(raw, value):
    assert strtoul(raw) == value


@pytest.mark.parametrize(
    "raw,unsigned,signed",
    [
        ("5", 5, 5),
        (" \t+5", 5, 5),
        ("-5", None, -5),
        ("5 ", None, None),
        ("0x5", None, None),
        ("", None, None),
        ("+ 5", None, None),
        ("99999999999999999999", 99999999999999999999, 99999999999999999999),
    ],
)
def test_decimal_scanners_read_a_whole_decimal_word(raw, unsigned, signed):
    assert unsigned_decimal(raw) == unsigned
    assert signed_decimal(raw) == signed


def test_c_int_keeps_the_low_32_bits_signed():
    assert c_int(2**32 + 1) == 1
    assert c_int(2**64 - 1) == -1
    assert c_int(2**31) == -(2**31)


def test_scanners_read_a_number_past_the_int_digit_limit():
    digits = "9" * 5000
    assert unsigned_decimal(digits) == 10**5000 - 1
    assert signed_decimal("-" + digits) == -(10**5000 - 1)
    assert strtol(digits) == (2**63 - 1, "")
    assert strtoul(digits) == (2**64 - 1, "")
