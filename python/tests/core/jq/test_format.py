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

from mirage.core.jq import (
    JqError,
    JqHalt,
    JqOptions,
    JqRun,
    dump_text,
    error_report,
    format_one,
    halt_report,
    jq_run_texts,
    load_failure,
    printable,
)

PRETTY = JqOptions()
COMPACT = JqOptions(compact=True)
RAW = JqOptions(raw_output=True, compact=True)

# jq's compact dump of one document, and what jq 1.8.2 (debian:testing-slim)
# prints for it under each set of flags.
DOC = '{"b":1.000,"1":[1E+2,-0,{},[]],"a":[],"é":"ü😀\\u007f"}'
LAYOUTS = [
    (
        JqOptions(),
        b'{\n  "b": 1.000,\n  "1": [\n    1E+2,\n    -0,\n    {},\n'
        b'    []\n  ],\n  "a": [],\n  "\xc3\xa9": "\xc3\xbc\xf0\x9f\x98\x80'
        b'\\u007f"\n}\n',
    ),
    (
        JqOptions(compact=True),
        b'{"b":1.000,"1":[1E+2,-0,{},[]],"a":[],'
        b'"\xc3\xa9":"\xc3\xbc\xf0\x9f\x98\x80\\u007f"}\n',
    ),
    (
        JqOptions(sort_keys=True),
        b'{\n  "1": [\n    1E+2,\n    -0,\n    {},\n'
        b'    []\n  ],\n  "a": [],\n  "b": 1.000,\n  "\xc3\xa9": "\xc3\xbc'
        b'\xf0\x9f\x98\x80\\u007f"\n}\n',
    ),
    (
        JqOptions(sort_keys=True, compact=True),
        b'{"1":[1E+2,-0,{},[]],"a":[],"b":1.000,"\xc3\xa9":"\xc3\xbc\xf0\x9f'
        b'\x98\x80\\u007f"}\n',
    ),
    (
        JqOptions(tab=True),
        b'{\n\t"b": 1.000,\n\t"1": [\n\t\t1E+2,\n\t\t-0,\n'
        b'\t\t{},\n\t\t[]\n\t],\n\t"a": [],\n\t"\xc3\xa9": "\xc3\xbc\xf0\x9f'
        b'\x98\x80\\u007f"\n}\n',
    ),
    (
        JqOptions(indent=0),
        b'{\n"b": 1.000,\n"1": [\n1E+2,\n-0,\n{},\n[]\n],\n'
        b'"a": [],\n"\xc3\xa9": "\xc3\xbc\xf0\x9f\x98\x80\\u007f"\n}\n',
    ),
    (
        JqOptions(indent=7),
        b'{\n       "b": 1.000,\n       "1": [\n'
        b"              1E+2,\n              -0,\n              {},\n"
        b'              []\n       ],\n       "a": [],\n       "\xc3\xa9": '
        b'"\xc3\xbc\xf0\x9f\x98\x80\\u007f"\n}\n',
    ),
    (
        JqOptions(ascii_output=True),
        b'{\n  "b": 1.000,\n  "1": [\n    1E+2,\n'
        b'    -0,\n    {},\n    []\n  ],\n  "a": [],\n  "\\u00e9": "\\u00fc'
        b'\\ud83d\\ude00\\u007f"\n}\n',
    ),
    (
        JqOptions(ascii_output=True, sort_keys=True, tab=True),
        b'{\n\t"1": [\n\t\t1E+2,\n\t\t-0,\n\t\t{},\n\t\t[]\n\t],\n\t"a": [],\n'
        b'\t"b": 1.000,\n\t"\\u00e9": "\\u00fc\\ud83d\\ude00\\u007f"\n}\n',
    ),
    (
        JqOptions(raw_output=True),
        b'{\n  "b": 1.000,\n  "1": [\n    1E+2,\n'
        b'    -0,\n    {},\n    []\n  ],\n  "a": [],\n  "\xc3\xa9": "\xc3\xbc'
        b'\xf0\x9f\x98\x80\\u007f"\n}\n',
    ),
]

# A string, and what jq 1.8.2 prints for it.
STRING = '"ü😀\\u007f\\u0000"'
STRING_LAYOUTS = [
    (JqOptions(raw_output=True), b"\xc3\xbc\xf0\x9f\x98\x80\x7f\x00\n"),
    (
        JqOptions(raw_output=True, ascii_output=True),
        b'"\\u00fc\\ud83d\\ude00\\u007f\\u0000"\n',
    ),
    (
        JqOptions(raw_output=True, join_output=True),
        b"\xc3\xbc\xf0\x9f\x98\x80\x7f\x00",
    ),
    (JqOptions(ascii_output=True), b'"\\u00fc\\ud83d\\ude00\\u007f\\u0000"\n'),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("opts, expected", LAYOUTS)
async def test_an_output_is_laid_out_the_way_jq_prints_it(opts, expected):
    assert (await format_one(DOC, opts)) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("opts, expected", STRING_LAYOUTS)
async def test_a_string_output_is_printed_the_way_jq_prints_it(opts, expected):
    assert (await format_one(STRING, opts)) == expected


@pytest.mark.asyncio
async def test_a_deep_value_is_laid_out_without_recursion():
    deep = "[" * 300 + "1.000" + "]" * 300
    pretty = await dump_text(deep, PRETTY)
    assert pretty.startswith("[\n  [\n    [")
    assert "\n" + " " * 600 + "1.000\n" in pretty
    assert (
        await dump_text(
            '{"b":' * 300 + '{"a":1}' + "}" * 300,
            JqOptions(compact=True, sort_keys=True),
        )
    ).count('"b"') == 300


@pytest.mark.asyncio
@pytest.mark.parametrize("compact", [True, False])
async def test_sort_keys_orders_by_code_point_and_reads_escaped_keys(compact):
    # jq compares keys as UTF-8 bytes, which is code point order.
    text = '{"é":1,"z":2,"a\\"":3,"😀":4,"ｚ":5,"\\u0001":6}'
    ordered = '{"\\u0001":6,"a\\"":3,"z":2,"é":1,"ｚ":5,"😀":4}'
    opts = JqOptions(compact=compact, sort_keys=True)
    assert (await dump_text(text, opts)) == (
        await dump_text(ordered, JqOptions(compact=compact))
    )


@pytest.mark.asyncio
async def test_format_jq_raw_leaves_non_strings_as_json():
    assert (await format_one('"a"', RAW)) + (
        await format_one("1.000", RAW)
    ) == b"a\n1.000\n"


@pytest.mark.asyncio
async def test_join_output_writes_no_separator():
    opts = JqOptions(raw_output=True, join_output=True, compact=True)
    assert (await format_one('"a"', opts)) + (
        await format_one('"b"', opts)
    ) == b"ab"


@pytest.mark.asyncio
async def test_raw_output0_terminates_with_nul_and_beats_join():
    opts = JqOptions(
        raw_output=True, join_output=True, nul_output=True, compact=True
    )
    assert (await format_one('"a"', opts)) + (
        await format_one('"b"', opts)
    ) == b"a\x00b\x00"


@pytest.mark.asyncio
async def test_seq_puts_rs_before_each_value_but_not_a_raw_string():
    opts = JqOptions(seq=True, raw_output=True, compact=True)
    assert (
        b"".join(
            [(await format_one(text, opts)) for text in ["1.000", '"x"', "[]"]]
        )
        == b"\x1e1.000\nx\n\x1e[]\n"
    )


@pytest.mark.asyncio
async def test_raw_output0_refuses_a_string_holding_a_nul():
    # Pinned: printf '"a\u0000b" "c"' | jq --raw-output0 . fails the first
    # run with this error and prints the second.
    opts = JqOptions(raw_output=True, nul_output=True, compact=True)
    run = JqRun(['"x"', '"a\\u0000b"', '"c"'])
    assert (await printable(run, opts)) == JqRun(
        ['"x"'],
        JqError(
            "Cannot dump a string containing NUL with --raw-output0 option",
            True,
        ),
    )
    assert (await printable(JqRun(['"a\\\\u0000"']), opts)) == JqRun(
        ['"a\\\\u0000"']
    )
    assert (
        await printable(run, JqOptions(raw_output=True, compact=True))
    ) == run
    assert (
        await printable(run, JqOptions(nul_output=True, ascii_output=True))
    ) == run


@pytest.mark.asyncio
async def test_outputs_keep_the_spelling_jq_gives_them():
    run = jq_run_texts(
        '{"b":1.000,"1":2}', "., .b, (.b + 0), (1e17 * 1), -0, keys_unsorted"
    )
    assert b"".join(
        [(await format_one(text, COMPACT)) for text in run.outputs]
    ) == (b'{"b":1.000,"1":2}\n1.000\n1\n1e+17\n0\n["b","1"]\n')


def test_error_report_words_an_error_the_way_jq_does():
    assert error_report("<stdin>:1", JqError("boom", True)) == (
        "jq: error (at <stdin>:1): boom\n"
    )
    assert error_report("<unknown>", JqError('{"a":1}', False)) == (
        'jq: error (at <unknown>) (not a string): {"a":1}\n'
    )


def test_error_report_ends_a_string_message_at_a_nul():
    assert (
        error_report("f:0", JqError("a\0b", True)) == "jq: error (at f:0): a\n"
    )


@pytest.mark.parametrize(
    "message, string, expected",
    [
        ("bye\n", True, "bye\n"),
        ('{"a":1}', False, '{"a":1}\n'),
        (None, False, ""),
    ],
)
def test_halt_report_writes_what_jq_writes_for_a_halt(
    message, string, expected
):
    assert halt_report(JqHalt(message, string, 5)) == expected


@pytest.mark.parametrize(
    "exc, expected",
    [
        (
            FileNotFoundError("f"),
            "Could not open f: No such file or directory",
        ),
        (PermissionError("f"), "Could not open f: Permission denied"),
        (IsADirectoryError("f"), "Could not open f: It's a directory"),
    ],
)
def test_load_failure_words_a_file_jq_could_not_load(exc, expected):
    assert load_failure("f", exc) == expected
