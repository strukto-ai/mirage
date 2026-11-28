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

from mirage.commands.cli.builtin.tvly.render import (
    js_text,
    js_trim,
    json_text,
    member_text,
    pages_text,
    plain,
    sanitize_control,
    snippet,
    truthy,
    utf16_length,
    utf16_slice,
)


@pytest.mark.parametrize(
    ("value", "text"),
    [
        (None, "null"),
        (True, "true"),
        (1.0, "1"),
        (0.5, "0.5"),
        ([1, None, "a"], "1,,a"),
        ({"a": 1}, "[object Object]"),
    ],
)
def test_a_value_spells_as_javascripts_string_spells_it(value, text):
    assert js_text(value) == text


def test_an_empty_container_is_true_and_an_empty_string_false():
    assert truthy([]) and truthy({})
    assert not truthy("") and not truthy(0) and not truthy(None)


def test_trim_takes_javascripts_whitespace_set():
    assert js_trim("﻿  a 　") == "a"
    assert js_trim("\x1c a") == "\x1c a"


def test_lengths_and_cuts_count_utf16_units():
    assert utf16_length("a😀") == 3
    assert utf16_slice("a😀b", 2) == "a�"
    assert utf16_slice("a😀b", 3) == "a😀"


def test_controls_but_tab_newline_and_return_are_dropped():
    assert sanitize_control("a\x00b\x1b[31mc\x85d\te\n") == "ab[31mcd\te\n"


def test_plain_folds_blank_runs_and_trims_keeping_the_next_lines_indent():
    assert plain("  one\n\n\n \n two  ") == "one\n\n two"


def test_a_snippet_joins_whitespace_and_cuts_with_an_ellipsis():
    assert snippet("a  b\n\tc", 0) == "a b c"
    assert snippet("abcdef", 3) == "abc..."
    assert snippet("abc", 3) == "abc"


def test_a_missing_member_reads_undefined_and_a_null_one_null():
    assert member_text({"url": None}, "url") == "null"
    assert member_text({}, "url") == "undefined"


def test_json_spells_numbers_as_json_stringify_does():
    assert json_text({"a": 1.0, "b": [0.1]}, False) == '{"a":1,"b":[0.1]}'
    assert json_text({"a": []}, True) == '{\n  "a": []\n}'


def test_each_page_echoes_under_its_url():
    pages = [{"url": "https://a", "raw_content": "body"}, {"url": "https://b"}]
    assert pages_text(pages) == (
        "# https://a\n\nbody\n\n# https://b\n\n(no content)\n\n"
    )


def test_trim_is_linear_over_a_long_inner_run():
    assert (
        js_trim(" a" + " " * 200_000 + "b\ufeff") == "a" + " " * 200_000 + "b"
    )
