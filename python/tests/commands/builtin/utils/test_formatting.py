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

from mirage.commands.builtin.utils.formatting import format_number, to_number


def test_to_number_gnu_awk_coercion():
    assert to_number("3") == 3.0
    assert to_number("2.5x") == 2.5
    assert to_number("abc") == 0.0
    assert to_number(" -4.5 ") == -4.5
    assert to_number("1e3zzz") == 1000.0


def test_format_number_collapses_integral_floats():
    assert format_number(60.0) == "60"
    assert format_number(5.5) == "5.5"
