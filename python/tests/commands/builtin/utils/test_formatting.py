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

from mirage.commands.builtin.utils.formatting import (_human_size,
                                                      format_number,
                                                      parse_size, to_number)


def testparse_size_plain_and_human():
    assert parse_size("123") == 123
    assert parse_size("4.0K") == 4096
    assert parse_size("2.5M") == 2621440
    assert parse_size("7B") == 7


def testparse_size_inverts_human_size():
    for n in (0, 512, 4096, 1024**2, 3 * 1024**3):
        assert parse_size(_human_size(n)) == n


def test_to_number_gnu_awk_coercion():
    assert to_number("3") == 3.0
    assert to_number("2.5x") == 2.5
    assert to_number("abc") == 0.0
    assert to_number(" -4.5 ") == -4.5
    assert to_number("1e3zzz") == 1000.0


def test_format_number_collapses_integral_floats():
    assert format_number(60.0) == "60"
    assert format_number(5.5) == "5.5"
