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

from mirage.core.jq.eval import jq_eval, references_args, references_inputs


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


def test_named_args_bind_to_dollar_names():
    assert jq_eval({"a": 1}, "[.a, $v]", {"v": "hi"}) == [[1, "hi"]]


def test_named_args_carry_json_values():
    assert jq_eval(None, "$v", {"v": {"k": [1, 2]}}) == [{"k": [1, 2]}]


def test_inputs_yields_the_bound_documents():
    assert jq_eval(None, "[inputs]", None, [1, 2, 3]) == [[1, 2, 3]]


def test_inputs_binding_is_absent_without_documents():
    assert jq_eval({"a": 1}, ".a") == [1]


def test_a_program_defining_inputs_shadows_the_binding():
    assert jq_eval(None, "def inputs: 9; [inputs]", None, [1, 2]) == [[9]]


def test_references_inputs_finds_whole_words_only():
    assert references_inputs("[inputs]")
    assert references_inputs("reduce inputs as $x (0; . + $x)")
    assert not references_inputs(".myinputs")
    assert not references_inputs(".inputs_total")


def test_references_inputs_ignores_the_word_spelling_data():
    assert not references_inputs(".inputs")
    assert not references_inputs(".a.inputs")
    assert not references_inputs("$inputs")
    assert not references_inputs("{inputs: .a}")
    assert not references_inputs("{inputs}")
    assert not references_inputs("{a, inputs}")
    assert not references_inputs("m::inputs")


def test_references_inputs_ignores_strings_and_comments():
    assert not references_inputs('"no inputs found"')
    assert not references_inputs(". # drains inputs")
    assert not references_inputs('"a\\("b" + "inputs")c"')


def test_references_inputs_reads_calls_in_every_value_position():
    assert references_inputs("{a: inputs}")
    assert references_inputs("{(inputs): 1}")
    assert references_inputs("[1, inputs, 2]")
    assert references_inputs('"\\(inputs)"')


def test_references_args_ignores_strings_and_comments():
    assert references_args("$ARGS.positional")
    assert references_args("{$ARGS}")
    assert not references_args('"$ARGS"')
    assert not references_args(". # $ARGS")
    assert not references_args("$ARGSX")
