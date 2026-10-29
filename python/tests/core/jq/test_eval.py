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

from mirage.core.jq.eval import args_text, references_args, stream_reads
from mirage.core.jq.types import JqOptions, StreamReads


def test_stream_reads_finds_whole_words_only():
    assert stream_reads("[inputs]") == StreamReads(input=False, inputs=True)
    assert stream_reads("reduce inputs as $x (0; . + $x)").inputs
    assert stream_reads("input") == StreamReads(input=True, inputs=False)
    assert stream_reads("input as $h | [inputs]") == StreamReads(
        input=True, inputs=True
    )
    assert not stream_reads(".myinputs").inputs
    assert not stream_reads(".inputs_total").inputs
    assert not stream_reads("input_filename").input
    assert not stream_reads("input_line_number").input


@pytest.mark.parametrize(
    "expr",
    [
        ".inputs",
        ".a.inputs",
        "$inputs",
        "{inputs: .a}",
        "{inputs}",
        "{a, inputs}",
        "m::inputs",
    ],
)
def test_stream_reads_ignores_inputs_spelling_data(expr: str):
    assert not stream_reads(expr).inputs


@pytest.mark.parametrize(
    "expr", [".input", "$input", "{input: 1}", "{input}", "m::input"]
)
def test_stream_reads_ignores_input_spelling_data(expr: str):
    assert not stream_reads(expr).input


def test_stream_reads_ignores_strings_and_comments():
    assert not stream_reads('"no inputs found"').inputs
    assert not stream_reads(". # drains inputs").inputs
    assert not stream_reads('"a\\("b" + "inputs")c"').inputs
    assert not stream_reads('"read the input"').input


def test_stream_reads_ignores_a_function_the_program_defines():
    assert not stream_reads("def input: 1; input").input
    assert not stream_reads("def inputs: 9; [inputs]").inputs
    assert stream_reads("def f(x): x; f(input)").input


def test_stream_reads_finds_calls_in_every_value_position():
    assert stream_reads("{a: inputs}").inputs
    assert stream_reads("{(inputs): 1}").inputs
    assert stream_reads("[1, inputs, 2]").inputs
    assert stream_reads('"\\(inputs)"').inputs
    assert stream_reads("{a: input}").input


def test_references_args_ignores_strings_and_comments():
    assert references_args("$ARGS.positional")
    assert references_args("{$ARGS}")
    assert not references_args('"$ARGS"')
    assert not references_args(". # $ARGS")
    assert not references_args("$ARGSX")


def test_args_text_holds_both_binding_kinds():
    opts = JqOptions(
        positional_args=("1", '"a"'), named_args={"x": "2", "y": "[]"}
    )
    assert args_text(opts) == ('{"positional":[1,"a"],"named":{"x":2,"y":[]}}')
