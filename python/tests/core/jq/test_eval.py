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

from mirage.core.jq import eval as jq_eval_module
from mirage.core.jq.errors import JqCompileError
from mirage.core.jq.eval import (
    jq_check,
    jq_eval,
    jq_raised,
    jq_run,
    jq_run_texts,
    references_args,
    stream_reads,
)
from mirage.core.jq.types import JqError, JqHalt, JqRun, StreamReads


def test_single_output_is_a_one_element_list():
    assert jq_eval({"a": 1}, ".a") == [1]


def test_collector_program_evaluates_to_a_single_value():
    # `[.a[] | .t]` emits ONE array, so the caller prints one line.
    assert jq_eval({"a": [{"t": "x"}, {"t": "y"}]}, "[.a[] | .t]") == [
        ["x", "y"]
    ]


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


def test_a_program_defining_inputs_shadows_the_binding():
    assert jq_eval(None, "def inputs: 9; [inputs]", None, [1, 2]) == [[9]]


def test_input_takes_the_first_unread_document():
    assert jq_eval(None, "input", None, [{"n": 1}, {"n": 2}]) == [{"n": 1}]


def test_inputs_starts_after_the_document_input_took():
    assert jq_eval(None, "input as $h | [$h, [inputs]]", None, [1, 2, 3]) == [
        [1, [2, 3]]
    ]
    assert jq_eval(None, "[input, inputs]", None, [1, 2, 3]) == [[1, 2, 3]]


def test_input_fails_with_break_once_nothing_is_left():
    with pytest.raises(ValueError, match="break"):
        jq_eval(None, "input", None, [])
    assert jq_eval(None, "try input catch .", None, []) == ["break"]


def test_bindings_carry_values_of_any_size():
    big = "x" * 2_000_000
    assert jq_eval(None, "$x | length", {"x": big}) == [2_000_000]
    docs = [{"k": "x" * 90}] * 20_480
    assert jq_eval(None, "[inputs] | length", None, docs) == [20_480]


def test_a_compile_error_names_the_line_the_program_wrote_it_on():
    with pytest.raises(ValueError, match="at <top-level>, line 1,"):
        jq_eval(None, "1 +", None, [])
    with pytest.raises(ValueError, match="at <top-level>, line 2,"):
        jq_eval(None, ".\n| 1 +", None, [], {"named": {}})


def test_a_trailing_comment_leaves_the_program_whole():
    assert jq_eval(None, "[inputs] # every document", None, [1]) == [[1]]


def test_an_empty_program_keeps_jqs_own_refusal():
    with pytest.raises(ValueError, match="Top-level program not given"):
        jq_eval(None, "# nothing", None, [1])


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


@pytest.mark.parametrize(
    "expr, run",
    [
        ('.a, error("boom"), .a', JqRun([1], JqError("boom", True))),
        ('error({"b": 2})', JqRun([], JqError('{"b":2}', False))),
        ("error(null)", JqRun([], JqError("null", False))),
        ('error("null")', JqRun([], JqError("null", True))),
        (
            ".a | .b",
            JqRun([], JqError('Cannot index number with string ("b")', True)),
        ),
        ('"bye\\n" | halt_error', JqRun([], JqHalt("bye\n", True, 5))),
        ("[1] | halt_error(2)", JqRun([], JqHalt("[1]", False, 2))),
        ("null | halt_error", JqRun([], JqHalt(None, False, 5))),
        ('"a", halt', JqRun(["a"], JqHalt(None, False, None))),
        ("1, [halt_error(2)], 3", JqRun([1], JqHalt('{"a":1}', False, 2))),
        ("[.a] | map(halt_error(4))", JqRun([], JqHalt("1", False, 4))),
        (
            'try ("failure" | halt_error(3)) catch "continued"',
            JqRun([], JqHalt("failure", True, 3)),
        ),
        ('try (.a, halt) catch "c"', JqRun([1], JqHalt(None, False, None))),
        (
            '{"__mirage_jq_error": [true, "x"]}',
            JqRun([{"__mirage_jq_error": [True, "x"]}]),
        ),
        ('try error("x") catch .', JqRun(["x"])),
    ],
)
def test_a_run_hands_back_what_stopped_it(expr, run):
    assert jq_run({"a": 1}, expr) == run


def test_a_halt_whose_message_no_second_run_recovers_reads_as_the_default():
    # A halt in the program's own `try` inside a collector still ends the
    # run, but neither redefinition hands its message back.
    assert jq_run(1, '[try halt_error(2) catch "c"]') == JqRun(
        [], JqHalt(None, False, 5)
    )


def test_a_halt_reads_back_past_outputs_that_differ_from_run_to_run():
    # `now` prints another value when the program runs again for the halt.
    run = jq_run(None, 'now, ("x" | halt_error(3))')
    assert (len(run.outputs), run.stop) == (1, JqHalt("x", True, 3))


def test_a_program_that_can_halt_reads_jqs_own_clock_at_each_call():
    # The work between the two readings takes well over the microsecond
    # jq's clock counts in.
    run = jq_run(
        None,
        "now as $a | ([range(100000)] | length) as $n | "
        "now as $b | ($b > $a), halt",
    )
    assert run == JqRun([True], JqHalt(None, False, None))


def test_named_arguments_named_like_the_preludes_variables_stay_the_programs():
    named = {
        "__mirage_jq_value": "v",
        "__mirage_jq_named": "n",
        "__mirage_jq_inputs": "i",
        "__mirage_jq_args": "a",
    }
    program = (
        "., [$__mirage_jq_value, $__mirage_jq_named, "
        "$__mirage_jq_inputs, $__mirage_jq_args], input, "
        "($ARGS.named | keys)"
    )
    args = {"positional": [], "named": named}
    run = jq_run({"a": 1}, program, named, [2], args)
    assert run == JqRun([{"a": 1}, ["v", "n", "i", "a"], 2, sorted(named)])


def test_halt_error_refuses_a_code_that_is_not_a_number_as_jq_does():
    assert jq_run(1, 'halt_error("x")') == JqRun(
        [], JqError("number (1) halt_error/1: number required", True)
    )


# gojq tells an error the program raised with `error` from a builtin's,
# which jq never does; each verdict is gh 2.85's gojq's.
@pytest.mark.parametrize(
    "expr, raised",
    [
        ('.a, error("boom")', True),
        ('error({"b": 2})', True),
        ("error(null)", True),
        ('"x" | error', True),
        ("try (.a | .b) catch error", True),
        ('[error("in")]', True),
        ('first(error("in"))', True),
        ('label $out | error("in")', True),
        ('{v:error("tight")}', True),
        ('def f: error("in f"); try f catch error', True),
        ('(try error("x") catch .), error("y")', True),
        ('try error("x") catch error("wrapped: " + .)', True),
        ('now, error("x")', True),
        ('[now] | .[0], error("y")', True),
        ('range(20000), error("many")', True),
        (".a | .b", False),
        ("label $out | .a | .b", False),
        ('try error("x") catch (.a | .b)', False),
        ('(try error("x") catch .), (.a | .b)', False),
        (".error, (.a | .b)", False),
        ('"error" as $e | .a | .b # error', False),
        ("def error: 7; error | .b", False),
        ("limit(-1; .a)", False),
    ],
)
def test_jq_raised_tells_the_programs_own_error_from_a_builtins(expr, raised):
    run = jq_run({"a": 1}, expr)
    assert isinstance(run.stop, JqError)
    assert jq_raised({"a": 1}, expr, run) is raised


def test_an_error_no_rerun_can_speak_for_reads_as_a_builtins():
    # Neither rerun can speak for it: the catch reads the wrapped value
    # in the first, and the mark rides into the error in the second.
    expr = '(try error("x") catch .) as $m | error($m + "!")'
    run = jq_run(None, expr)
    assert run.stop == JqError("x!", True)
    assert jq_raised(None, expr, run) is False


def test_jq_raised_is_false_for_a_run_no_error_stopped():
    assert jq_raised(1, '"a", halt', jq_run(1, '"a", halt')) is False
    assert jq_raised(1, ".", jq_run(1, ".")) is False


def test_a_run_keeps_the_programs_own_line_numbers():
    assert jq_run(None, "$__loc__ | .line") == JqRun([1])
    assert jq_run(None, "$__loc__ | .line", inputs=[]) == JqRun([1])


def test_code_that_closes_the_prelude_early_is_refused_as_jq_refuses_it():
    with pytest.raises(JqCompileError, match="syntax error"):
        jq_run(1, "1) catch 2 | try (3")


def test_a_compile_error_reads_as_the_program_numbers_its_lines():
    with pytest.raises(JqCompileError, match="line 2, column"):
        jq_run(1, ".a |\n  nosuch(1)", args_value={"positional": []})


def test_a_program_is_checked_without_being_run():
    jq_check("repeat(1)")
    with pytest.raises(JqCompileError, match="1 compile error"):
        jq_check("1 +")


# jq_run_texts runs on JSON text and hands back jq's own dump of each
# output; every expectation is what jq 1.8.2 prints for the same program.
def test_a_text_run_keeps_every_literal_and_the_key_order_jq_reads():
    run = jq_run_texts(
        '{"b":1,"1":2,"a":{"z":1,"0":2}}',
        '., keys, keys_unsorted, (. + {"c":3})',
    )
    assert run == JqRun(
        [
            '{"b":1,"1":2,"a":{"z":1,"0":2}}',
            '["1","a","b"]',
            '["b","1","a"]',
            '{"b":1,"1":2,"a":{"z":1,"0":2},"c":3}',
        ]
    )
    run = jq_run_texts(
        "[1.000, 1e2, -0, 100000000000000000001]",
        ".[], (.[3] + 1), (.[0] | tojson), map(. * 1)",
    )
    assert run.outputs == [
        "1.000",
        "1E+2",
        "-0",
        "100000000000000000001",
        "1e+20",
        '"1.000"',
        "[1,100,-0,1e+20]",
    ]


def test_a_text_run_reads_the_environment_it_is_given():
    env = '{"HOME":"/home/a"}'
    run = jq_run_texts("null", "[$ENV.HOME, env.HOME]", env=env)
    assert run == JqRun(['["/home/a","/home/a"]'])
    run = jq_run_texts("null", "[$ENV, env.HOME]", {"ENV": '"x"'}, env=env)
    assert run == JqRun(['[{"HOME":"/home/a"},"/home/a"]'])
    run = jq_run_texts("null", "def env: 1; env", env=env)
    assert run == JqRun(["1"])


def test_a_text_run_reports_errors_and_halts_in_jqs_own_spelling():
    assert jq_run_texts("1.000", '. + "a"').stop == JqError(
        'number (1.000) and string ("a") cannot be added', True
    )
    assert jq_run_texts('{"b":1.000,"1":2}', "error").stop == JqError(
        '{"b":1.000,"1":2}', False
    )
    assert jq_run_texts('{"b":1.000,"1":2}', "halt_error").stop == JqHalt(
        '{"b":1.000,"1":2}', False, 5
    )


def test_a_text_run_binds_its_arguments_and_unread_documents_as_text():
    run = jq_run_texts(
        "null",
        "$v, $ARGS, input, [inputs]",
        {"v": '{"b":1,"1":2.50}'},
        ["1.0", "2.00", "3e2"],
        '{"positional":[1.0],"named":{"v":{"b":1,"1":2.50}}}',
    )
    assert run.outputs == [
        '{"b":1,"1":2.50}',
        '{"positional":[1.0],"named":{"v":{"b":1,"1":2.50}}}',
        "1.0",
        "[2.00,3E+2]",
    ]


def test_a_text_run_meets_the_parse_error_past_the_unread_documents():
    message = "Unfinished JSON term at EOF at line 1, column 3"
    assert jq_run_texts(
        "null", "[inputs]", None, ["1.0"], None, message
    ) == JqRun([], JqError(message, True))


def test_a_text_run_dumps_a_program_its_comment_carries_on_past_a_line():
    # jq 1.8.2 carries a comment over a backslash at its line's end, so a
    # program ending in one is run as typed, and still dumped.
    assert jq_run_texts("5.0", ". # c \\") == JqRun(["5.0"])
    assert jq_run_texts("5.0", "[.] # c") == JqRun(["[5.0]"])


@pytest.mark.parametrize("definition", ["42", "empty", 'error("shadow")'])
@pytest.mark.parametrize("suffix", ["", " # c", " # c \\"])
def test_output_dumping_is_independent_of_user_defined_tojson(
    definition, suffix
):
    doc = '{"b":1.000,"1":[-0,100000000000000000001]}'
    assert jq_run_texts(doc, f"def tojson: {definition}; .{suffix}") == JqRun(
        [doc]
    )


def test_as_typed_dumping_preserves_user_calls_and_each_output():
    assert jq_run_texts("1.000", "def tojson: 42; ., tojson # c \\") == JqRun(
        ["1.000", "42"]
    )


def test_as_typed_dumping_preserves_bindings_and_unread_documents():
    assert jq_run_texts(
        "null",
        "def tojson: empty; $v, $ARGS, input, [inputs] # c \\",
        {"v": '{"b":1.000,"1":2}'},
        ["-0", "1e2"],
        '{"positional":[2.50],"named":{}}',
    ) == JqRun(
        [
            '{"b":1.000,"1":2}',
            '{"positional":[2.50],"named":{}}',
            "-0",
            "[1E+2]",
        ]
    )


def test_a_program_compiles_once_for_every_document():
    jq_eval_module._compile.cache_clear()
    for doc in ("1", "2.0", '{"a":3}'):
        jq_run_texts(doc, ". as $x | $x")
    info = jq_eval_module._compile.cache_info()
    assert (info.misses, info.hits) == (1, 2)
