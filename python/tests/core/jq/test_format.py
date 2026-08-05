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

from mirage.core.jq import JqOptions, format_jq_output, jq_eval

PRETTY = JqOptions()
COMPACT = JqOptions(compact=True)
RAW = JqOptions(raw_output=True, compact=True)


def test_format_jq_no_outputs_is_empty_bytes():
    assert format_jq_output([], PRETTY) == b""
    assert format_jq_output([], RAW) == b""


def test_format_jq_single_value_compact():
    assert format_jq_output([{"a": 1}], COMPACT) == b'{"a":1}\n'


def test_format_jq_single_value_indents_by_default():
    assert format_jq_output([{"a": 1}], PRETTY) == b'{\n  "a": 1\n}\n'


def test_format_jq_raw_string():
    assert format_jq_output(["hello"], RAW) == b"hello\n"


def test_format_jq_raw_leaves_non_strings_as_json():
    assert format_jq_output(["a", 1], RAW) == b"a\n1\n"


def test_format_jq_prints_one_line_per_output():
    assert format_jq_output([1, 2, 3], COMPACT) == b"1\n2\n3\n"


def test_format_jq_one_array_output_stays_one_line():
    assert format_jq_output([[1, 2, 3]], COMPACT) == b"[1,2,3]\n"


def test_select_no_match_formats_to_nothing():
    outputs = jq_eval({"x": 1}, "select(.x > 100)")
    assert format_jq_output(outputs, COMPACT) == b""


def test_comma_formats_one_value_per_line():
    outputs = jq_eval({"a": "alice", "b": 30}, ".a, .b")
    assert format_jq_output(outputs, RAW) == b"alice\n30\n"


def test_join_output_writes_no_separator():
    opts = JqOptions(raw_output=True, join_output=True, compact=True)
    assert format_jq_output(["a", "b"], opts) == b"ab"


def test_raw_output0_terminates_with_nul_and_beats_join():
    opts = JqOptions(raw_output=True,
                     join_output=True,
                     nul_output=True,
                     compact=True)
    assert format_jq_output(["a", "b"], opts) == b"a\x00b\x00"


def test_sort_keys_orders_object_keys():
    opts = JqOptions(compact=True, sort_keys=True)
    assert format_jq_output([{"b": 1, "a": 2}], opts) == b'{"a":2,"b":1}\n'


def test_ascii_output_escapes_and_beats_raw():
    opts = JqOptions(raw_output=True, ascii_output=True, compact=True)
    assert format_jq_output(["café"], opts) == b'"caf\\u00e9"\n'


def test_ascii_output_sorts_keys_through_the_stdlib_encoder():
    opts = JqOptions(compact=True, ascii_output=True, sort_keys=True)
    assert format_jq_output([{"b": "é", "a": 1}], opts) == \
        b'{"a":1,"b":"\\u00e9"}\n'


def test_tab_indents_with_tabs():
    assert format_jq_output([{"a": 1}], JqOptions(tab=True)) == \
        b'{\n\t"a": 1\n}\n'


def test_indent_width_is_honored():
    assert format_jq_output([{"a": 1}], JqOptions(indent=4)) == \
        b'{\n    "a": 1\n}\n'


def test_indent_zero_is_compact():
    assert format_jq_output([{"a": 1}], JqOptions(indent=0)) == b'{"a":1}\n'
