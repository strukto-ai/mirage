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

from mirage.shell.arith import plain_decimal


def test_plain_decimal_reads_ascii_digits():
    assert plain_decimal("42") == 42
    assert plain_decimal(" 7\n") == 7


def test_plain_decimal_wraps_to_64_bits():
    assert plain_decimal("9223372036854775808") == -9223372036854775808
    assert plain_decimal("18446744073709551617") == 1


def test_plain_decimal_leaves_the_rest_to_the_evaluator():
    for text in ("", "0", "010", "1+1", "-3", "x", "٣"):
        assert plain_decimal(text) is None
