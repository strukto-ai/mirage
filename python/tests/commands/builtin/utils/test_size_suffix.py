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

from mirage.commands.builtin.utils.size_suffix import (
    decimal_value,
    parse_base0,
)


def test_parse_base0_reads_hex_octal_and_decimal():
    assert parse_base0("0x400") == 1024
    assert parse_base0("0X10") == 16
    assert parse_base0("010") == 8
    assert parse_base0("007") == 7
    assert parse_base0("1010") == 1010
    assert parse_base0("0") == 0


def test_decimal_value_reads_past_the_int_digit_limit():
    digits = "9" * 5000
    assert decimal_value(digits) == 10**5000 - 1
    assert decimal_value("000123") == 123
    assert parse_base0(digits) == 10**5000 - 1
