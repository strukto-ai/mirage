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

from mirage.workspace.expand.brace import (expand_template, make_inert,
                                           substitute)

EXPAND_CASES = [
    ("{a,b,c}", ["a", "b", "c"]),
    ("x{a,b}y", ["xay", "xby"]),
    ("{a,b}.txt", ["a.txt", "b.txt"]),
    ("a{,b}c", ["ac", "abc"]),
    ("a{,}b", ["ab", "ab"]),
    ("{,x}", ["", "x"]),
    ("{a,b}{1,2}", ["a1", "a2", "b1", "b2"]),
    ("pre{a,b}", ["prea", "preb"]),
    ("{1..5}", ["1", "2", "3", "4", "5"]),
    ("{5..1}", ["5", "4", "3", "2", "1"]),
    ("{-2..2}", ["-2", "-1", "0", "1", "2"]),
    ("{1..9..2}", ["1", "3", "5", "7", "9"]),
    ("{9..1..2}", ["9", "7", "5", "3", "1"]),
    ("{1..9..-2}", ["1", "3", "5", "7", "9"]),
    ("{01..10}", ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"]),
    ("{001..5}", ["001", "002", "003", "004", "005"]),
    ("{01..10..3}", ["01", "04", "07", "10"]),
    ("{-05..5..5}", ["-05", "000", "005"]),
    ("{3..3}", ["3"]),
    ("{a..e}", ["a", "b", "c", "d", "e"]),
    ("{e..a}", ["e", "d", "c", "b", "a"]),
    ("{a..i..2}", ["a", "c", "e", "g", "i"]),
    ("{A..D}", ["A", "B", "C", "D"]),
    ("{Y..b}", ["Y", "Z", "[", "\\", "]", "^", "_", "`", "a", "b"]),
    ("{c..c}", ["c"]),
    ("{a,{b,c}}", ["a", "b", "c"]),
    ("x{a,{1,2}b}y", ["xay", "x1by", "x2by"]),
    ("{a,{1..3}}", ["a", "1", "2", "3"]),
    ("{{a,b},{c,{d,e}}}", ["a", "b", "c", "d", "e"]),
    ("{a,{,}}", ["a", "", ""]),
    ("{ab{1,2}}", ["{ab1}", "{ab2}"]),
    ("a{b{1,2}c", ["a{b1c", "a{b2c"]),
    ("{abc}{1,2}", ["{abc}1", "{abc}2"]),
]

LITERAL_CASES = [
    "{a}",
    "{}",
    "{a,b",
    "a,b}",
    "{a..}",
    "{1..b}",
    "{1..5..x}",
    "{abc}",
    "{aa..bb}",
    "{a\\,b}",
    "{1...3}",
    "plain",
]


@pytest.mark.parametrize("template,expected", EXPAND_CASES)
def test_expand_template(template, expected):
    assert expand_template(template) == expected


@pytest.mark.parametrize("template", LITERAL_CASES)
def test_literal_templates_return_none(template):
    assert expand_template(template) is None


def test_inert_atom_alternates_but_never_forms_a_range():
    atom = make_inert(0)
    assert expand_template("{a," + atom + "}") == ["a", atom]
    assert expand_template("{1.." + atom + "}") is None


def test_inert_prefix_and_suffix_stitch():
    atom = make_inert(0)
    assert expand_template(atom + "{a,b}") == [atom + "a", atom + "b"]
    assert expand_template("{a,b}" + atom) == ["a" + atom, "b" + atom]


def test_substitute_replaces_atoms_in_order():
    word = "x" + make_inert(0) + "y" + make_inert(1)
    assert substitute(word, ["A", "B"]) == "xAyB"


def test_substitute_without_atoms_is_identity():
    assert substitute("plain", ["unused"]) == "plain"
