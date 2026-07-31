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

from mirage.core.jq.eval import jq_eval


def test_single_output_is_a_one_element_list():
    assert jq_eval({"a": 1}, ".a") == [1]


def test_collector_program_evaluates_to_a_single_value():
    # `[.a[] | .t]` emits ONE array, so the caller prints one line.
    assert jq_eval({"a": [{
        "t": "x"
    }, {
        "t": "y"
    }]}, "[.a[] | .t]") == [["x", "y"]]


def test_spread_program_evaluates_to_one_output_per_element():
    assert jq_eval({"a": [1, 2, 3]}, ".a[]") == [1, 2, 3]


def test_comma_is_two_outputs_not_one_array():
    assert jq_eval({"a": 1, "b": 2}, ".a, .b") == [1, 2]


def test_comma_over_arrays_keeps_each_array_whole():
    assert jq_eval({"a": 1, "b": 2}, "[.a], [.b]") == [[1], [2]]


def test_multi_output_without_a_bracket_pair():
    # `range` and `..` spread with no `[]` anywhere in the program.
    assert jq_eval(None, "range(3)") == [0, 1, 2]
    assert jq_eval({"a": 1}, "..") == [{"a": 1}, 1]


def test_bracket_pair_inside_a_string_literal_is_one_output():
    assert jq_eval({"a": "x[]y"}, '.a | contains("[]")') == [True]


def test_zero_outputs_is_an_empty_list():
    assert jq_eval({"x": 1}, "select(.x > 100)") == []
    assert jq_eval({}, "empty") == []


def test_optional_spread_over_a_missing_field_is_empty():
    """Reproducer for the 'jq: DropItem' regression: an `[]?` over a
    missing field used to leak the internal sentinel exception."""
    msg = {"id": "x", "subject": "hi", "body_text": "..."}
    assert jq_eval(msg, ".attachments[]?") == []
