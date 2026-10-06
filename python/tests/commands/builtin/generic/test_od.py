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

from mirage.commands.builtin.generic.od import parse_count
from mirage.commands.errors import UsageError


# strtoumax base 0 (0x hex, leading 0 octal), GNU size suffixes, and one
# leading '+' or whitespace that keeps the radix.
@pytest.mark.parametrize(
    "raw, flag, value",
    [
        ("010K", "-N", 8192),
        ("+0x10", "-N", 16),
    ],
)
def test_parse_count_accepts(raw, flag, value):
    assert parse_count(raw, flag) == value


@pytest.mark.parametrize("value", ["", "+ 10"])
def test_junk_number_uses_invalid_argument_message(value):
    with pytest.raises(UsageError) as exc:
        parse_count(value, "-N")
    assert str(exc.value) == f"od: invalid -N argument '{value}'"
    assert exc.value.exit_code == 1


@pytest.mark.parametrize("value", ["08", "0x"])
def test_junk_suffix_uses_invalid_suffix_message(value):
    # GNU distinguishes an unparseable number from an unknown suffix; 08
    # is octal-0 followed by the junk suffix "8", matching strtoumax.
    with pytest.raises(UsageError) as exc:
        parse_count(value, "-j")
    assert str(exc.value) == f"od: invalid suffix in -j argument '{value}'"


def test_uintmax_overflow_reports_too_large():
    # Q/R/Y/Z are in GNU's suffix set but always overflow uintmax.
    with pytest.raises(UsageError) as exc:
        parse_count("1Q", "-N")
    assert str(exc.value) == "od: -N argument '1Q' too large"


def test_uintmax_boundary_is_exact():
    # 2**64 - 1 is valid and 2**64 is not, in every radix (pinned against
    # coreutils 9.7).
    assert parse_count("18446744073709551615", "-N") == 2**64 - 1
    assert parse_count("0xffffffffffffffff", "-N") == 2**64 - 1
    with pytest.raises(UsageError) as exc:
        parse_count("18446744073709551616", "-N")
    assert str(exc.value) == (
        "od: -N argument '18446744073709551616' too large"
    )
    with pytest.raises(UsageError) as exc:
        parse_count("0x10000000000000000", "-j")
    assert str(exc.value) == (
        "od: -j argument '0x10000000000000000' too large"
    )
