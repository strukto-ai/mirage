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

import re

import pytest

from mirage.commands.builtin.constants import PatternType
from mirage.commands.builtin.grep_helper import (NEVER_MATCH, classify_pattern,
                                                 compile_pattern,
                                                 extract_required_literal,
                                                 merge_pattern_list,
                                                 search_query)


def test_single_pattern_keeps_regex_semantics():
    pat = compile_pattern("fo+")
    assert pat.search("foo")
    assert not pat.search("f")


def test_single_fixed_string_escapes():
    pat = compile_pattern("a.b", fixed_string=True)
    assert pat.search("xa.by")
    assert not pat.search("axb")


def test_newline_separated_patterns_match_any():
    pat = compile_pattern("foo\nbar")
    assert pat.search("a foo b")
    assert pat.search("a bar b")
    assert not pat.search("baz")


def test_newline_separated_regex_alternation_grouping():
    pat = compile_pattern("ab+\ncd")
    assert pat.search("abb")
    assert pat.search("xcdy")
    assert not pat.search("ax")


def test_newline_separated_fixed_strings_escape_each():
    pat = compile_pattern("a.b\nc+", fixed_string=True)
    assert pat.search("xa.by")
    assert pat.search("c+")
    assert not pat.search("axb")
    assert not pat.search("cc")


def test_newline_separated_whole_word_applies_per_pattern():
    pat = compile_pattern("foo\nbar", whole_word=True)
    assert pat.search("a foo b")
    assert pat.search("bar.")
    assert not pat.search("foobar")


def test_newline_separated_ignore_case():
    pat = compile_pattern("foo\nbar", ignore_case=True)
    assert pat.search("FOO")
    assert pat.search("Bar")


def test_classify_pattern_newline_list_is_regex():
    assert classify_pattern("foo\nbar", False) == PatternType.REGEX
    assert classify_pattern("foo\nbar", True) == PatternType.REGEX
    assert classify_pattern("foo bar", False) == PatternType.SIMPLE


def test_merge_pattern_list_file_only():
    assert merge_pattern_list(None, b"foo\nbar\n") == "foo\nbar"


def test_merge_pattern_list_combines_flag_and_file():
    assert merge_pattern_list("x", b"y\nz\n") == "x\ny\nz"


def test_merge_pattern_list_no_file_keeps_pattern():
    assert merge_pattern_list("x", None) == "x"


def test_merge_pattern_list_empty_file_is_none():
    assert merge_pattern_list(None, b"") is None


def test_merge_pattern_list_blank_line_matches_all():
    assert merge_pattern_list(None, b"\n") == ""


def test_never_match_pattern_matches_nothing():
    pat = compile_pattern(NEVER_MATCH)
    assert not pat.search("")
    assert not pat.search("anything")


@pytest.mark.parametrize("pattern,expected", [
    ("import.*os", "import"),
    ("imp.*rt", "imp"),
    ("^import", "import"),
    ("colou?r", "colo"),
    ("[Ee]rror", "rror"),
    (r"\d+error", "error"),
    ("config$", "config"),
    ("a*b", None),
    ("ab", None),
    ("foo|bar", None),
    ("(ab)?cdef", "cdef"),
])
def test_extract_required_literal(pattern, expected):
    assert extract_required_literal(pattern) == expected


def test_extract_literal_is_required_substring():
    for pattern in ("import.*os", "colou?r", "[Ee]rror", r"\d+error"):
        literal = extract_required_literal(pattern)
        assert literal is not None
        for sample in ("import sys, os", "color", "colour", "Error here",
                       "an error", "x42error"):
            if re.search(pattern, sample):
                assert literal in sample


def test_search_query_literal_returns_pattern():
    assert search_query("import", False) == "import"
    assert search_query("foo", True) == "foo"


def test_search_query_regex_extracts_literal():
    assert search_query("import.*os", False) == "import"


def test_search_query_regex_no_literal_is_none():
    assert search_query("foo|bar", False) is None
