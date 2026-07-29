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

from mirage.core.jq.eval import has_top_level_spread, jq_eval


def test_top_level_spread_is_detected():
    assert has_top_level_spread(".a[]")
    assert has_top_level_spread(".[] | .name")


def test_spread_inside_a_collector_is_not_top_level():
    # `[.a[] | .t]` emits ONE array, so the caller must print one line.
    assert not has_top_level_spread("[.a[] | .t]")
    assert not has_top_level_spread('[["H"]] + [.[] | [.]]')


def test_spread_inside_parens_is_not_top_level():
    assert not has_top_level_spread("([.a[]] | length)")


def test_bracket_pair_in_a_string_literal_is_not_a_spread():
    assert not has_top_level_spread('.a | test("[]")')


def test_index_and_slice_are_not_spreads():
    assert not has_top_level_spread(".values[1:]")
    assert not has_top_level_spread(".a[0]")


def test_collector_program_evaluates_to_a_single_value():
    result = jq_eval({"a": [{"t": "x"}, {"t": "y"}]}, "[.a[] | .t]")
    assert result == ["x", "y"]


def test_spread_program_evaluates_to_the_output_list():
    result = jq_eval({"a": [1, 2, 3]}, ".a[]")
    assert result == [1, 2, 3]
