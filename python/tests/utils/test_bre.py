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

from mirage.utils.bre import bre_to_python

# Every row is a differential result against GNU grep 3.x on Debian:
# the pattern, a subject it matches, and a subject it must not. The
# untranslated pattern passed all of these to Python's engine and got
# the opposite answer on most of them, which is why the bug survived.
CASES = [
    ("a+b", "a+b", "aab"),
    (r"a\+b", "aab", "a+b"),
    ("a?b", "a?b", "ab"),
    (r"a\?b", "ab", "xyz"),
    ("a|b", "a|b", "ab"),
    (r"a\|b", "ab", "xyz"),
    ("(ab)", "(ab)", "ab"),
    (r"\(ab\)", "ab", "ba"),
    ("a{2}", "a{2}", "aa"),
    (r"a\{2\}", "aa", "aba"),
    ("*abc", "*abc", "abc"),
    ("^*abc", "*abc", "abc"),
    ("a^b", "a^b", "ab"),
    ("a$b", "a$b", "ab"),
    (r"a\.b", "a.b", "axb"),
    ("a.b", "axb", "ab"),
    ("[+?]", "a+b", "ab"),
    (r"\(a\)\1", "aa", "ab"),
    (r"\(^ab\)", "ab", "xab"),
    (r"a\{1,\}", "a", "b"),
]


@pytest.mark.parametrize("pattern,hit,miss", CASES)
def test_matches_gnu_basic_expression_semantics(pattern, hit, miss):
    compiled = re.compile(bre_to_python(pattern))
    assert compiled.search(hit), f"{pattern!r} should match {hit!r}"
    assert not compiled.search(miss), f"{pattern!r} should miss {miss!r}"


def test_a_bracket_expression_is_copied_out_whole():
    # Everything inside brackets is already ordinary in both dialects,
    # so translating inside one would escape characters that are fine.
    assert bre_to_python("[a+?]") == "[a+?]"


def test_a_bracket_expression_may_hold_a_literal_close():
    assert bre_to_python("[]]") == "[]]"


def test_a_negated_bracket_may_hold_a_literal_close():
    assert bre_to_python("[^]]") == "[^]]"


def test_a_named_class_does_not_end_the_bracket_early():
    assert bre_to_python("[[:alpha:]+]") == "[[:alpha:]+]"


def test_a_trailing_dollar_still_anchors():
    assert bre_to_python("ab$") == "ab$"


def test_a_leading_caret_still_anchors():
    assert bre_to_python("^ab") == "^ab"


def test_an_escaped_backslash_stays_escaped():
    assert re.compile(bre_to_python(r"a\\b")).search("a\\b")


def test_an_empty_pattern_translates_to_nothing():
    assert bre_to_python("") == ""
