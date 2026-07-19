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

from mirage.workspace.expand.variable import (_arith_int, _case_mod,
                                              _expand_dollar_refs,
                                              _glob_replace, _glob_strip,
                                              _lookup_var, _slice_array)
from mirage.workspace.session import Session


@pytest.mark.parametrize("value,pattern,replacement,all_,anchor,expected", [
    ("hello", "l", "L", False, None, "heLlo"),
    ("hello", "l", "L", True, None, "heLLo"),
    ("banana", "a*", "X", False, None, "bX"),
    ("hello", "l?", "X", False, None, "heXo"),
    ("hello", "he", "HE", False, "#", "HEllo"),
    ("hello", "lo", "X", False, "#", "hello"),
    ("hello", "lo", "LO", False, "%", "helLO"),
    ("hello", "he", "X", False, "%", "hello"),
    ("a b c", " ", "_", True, None, "a_b_c"),
    ("abc", "*", "X", False, None, "X"),
    ("abc", "*", "X", True, None, "X"),
    ("", "*", "X", False, None, "X"),
    ("hello", "", "X", False, None, "hello"),
    ("hello", "xyz", "X", True, None, "hello"),
])
def test_glob_replace(value, pattern, replacement, all_, anchor, expected):
    assert _glob_replace(value, pattern, replacement, all_, anchor) == expected


@pytest.mark.parametrize("op,val,pattern,expected", [
    ("^^", "hello", "", "HELLO"),
    ("^^", "hello", "[el]", "hELLo"),
    ("^", "hello", "", "Hello"),
    ("^", "hello", "[x]", "hello"),
    (",,", "HELLO", "", "hello"),
    (",", "HELLO", "[H]", "hELLO"),
])
def test_case_mod(op, val, pattern, expected):
    assert _case_mod(op, val, pattern) == expected


def test_glob_strip_class_negation():
    assert _glob_strip("abc", "[!x]", False, True) == "bc"
    assert _glob_strip("abc", "[^x]", False, True) == "bc"


def test_expand_dollar_refs():
    session = Session(session_id="t", env={"ext": ".txt", "pat": "l"})
    assert _expand_dollar_refs("$ext", session, None) == ".txt"
    assert _expand_dollar_refs("*${ext}", session, None) == "*.txt"
    assert _expand_dollar_refs("a$pat*b", session, None) == "al*b"
    assert _expand_dollar_refs("no refs", session, None) == "no refs"
    assert _expand_dollar_refs("${unclosed", session, None) == "${unclosed"


def test_lookup_var_array_first_element():
    session = Session(session_id="t", arrays={"a": ["one", "two"]})
    assert _lookup_var("a", session, None) == "one"


@pytest.mark.parametrize("groups,expected", [
    (["1"], ["2", "3", "4"]),
    (["1", "2"], ["2", "3"]),
    (["-2"], ["3", "4"]),
    (["1", "-1"], ["2", "3"]),
    (["notanum;"], ["1", "2", "3", "4"]),
])
def test_slice_array(groups, expected):
    assert _slice_array(["1", "2", "3", "4"], groups, {}) == expected


def test_arith_int_resolves_expressions():
    assert _arith_int("3", {}) == 3
    assert _arith_int(" -2 ", {}) == -2
    assert _arith_int("1+1", {}) == 2
    assert _arith_int("i+1", {"i": "1"}) == 2
    assert _arith_int("o", {"o": "2"}) == 2
