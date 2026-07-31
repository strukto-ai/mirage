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

from mirage.core.jq import format_jq_output, jq_eval


def test_format_jq_no_outputs_is_empty_bytes():
    assert format_jq_output([], raw=False, compact=False) == b""
    assert format_jq_output([], raw=True, compact=True) == b""


def test_format_jq_single_value_compact():
    assert format_jq_output([{
        "a": 1
    }], raw=False, compact=True) == b'{"a":1}\n'


def test_format_jq_single_value_indents_by_default():
    assert format_jq_output([{
        "a": 1
    }], raw=False, compact=False) == b'{\n  "a": 1\n}\n'


def test_format_jq_raw_string():
    assert format_jq_output(["hello"], raw=True, compact=True) == b"hello\n"


def test_format_jq_raw_leaves_non_strings_as_json():
    assert format_jq_output(["a", 1], raw=True, compact=True) == b"a\n1\n"


def test_format_jq_prints_one_line_per_output():
    assert format_jq_output([1, 2, 3], raw=False, compact=True) == b"1\n2\n3\n"


def test_format_jq_one_array_output_stays_one_line():
    out = format_jq_output([[1, 2, 3]], raw=False, compact=True)
    assert out == b"[1,2,3]\n"


def test_select_no_match_formats_to_nothing():
    outputs = jq_eval({"x": 1}, "select(.x > 100)")
    assert format_jq_output(outputs, raw=False, compact=True) == b""


def test_comma_formats_one_value_per_line():
    outputs = jq_eval({"a": "alice", "b": 30}, ".a, .b")
    assert format_jq_output(outputs, raw=True, compact=True) == b"alice\n30\n"
