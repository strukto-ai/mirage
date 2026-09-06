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

from mirage.shell.errors import ExitSignal
from mirage.shell.variable import ShellVar
from mirage.workspace.expand.variable import (_ArithOperand, _case_mod,
                                              _glob_replace, _glob_strip,
                                              _lookup_var, _pattern_text,
                                              _slice_array)
from mirage.workspace.session import Session
from mirage.workspace.session.session import vars_from_env
from mirage.workspace.session.state import seed_var


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


def test_pattern_text_splices_refs_live():
    session = Session(session_id="t",
                      vars=vars_from_env({
                          "ext": ".txt",
                          "pat": "l"
                      }))
    assert _pattern_text("$ext", session, None) == ".txt"
    assert _pattern_text("*${ext}", session, None) == "*.txt"
    assert _pattern_text("a$pat*b", session, None) == "al*b"
    assert _pattern_text("no refs", session, None) == "no refs"
    assert _pattern_text("${unclosed", session, None) == "${unclosed"


def test_pattern_text_binds_backslash_escapes():
    # bash 5.2: ${v#a\*} strips a literal a*, so the escaped
    # character is spelled as a one-character class for the
    # escape-less fnmatch; a trailing lone backslash stays itself.
    session = Session(session_id="t", vars=vars_from_env({}))
    assert _pattern_text("a\\*b", session, None) == "a[*]b"
    assert _pattern_text("\\\\", session, None) == "\\"
    assert _pattern_text("a\\", session, None) == "a\\"


def test_lookup_var_array_first_element():
    session = Session(session_id="t", vars={"a": ShellVar(["one", "two"])})
    assert _lookup_var("a", session, None) == "one"


@pytest.mark.parametrize("groups,expected", [
    (["1"], ["2", "3", "4"]),
    (["1", "2"], ["2", "3"]),
    (["-2"], ["3", "4"]),
    (["1", "-1"], ["2", "3"]),
])
def test_slice_array(groups, expected):
    operand = _ArithOperand(Session(session_id="s", cwd="/"))
    assert _slice_array(["1", "2", "3", "4"], groups, operand) == expected


def test_arith_operand_resolves_expressions_and_records_writes():
    session = Session(session_id="s", cwd="/")
    seed_var(session, "i", "1")
    seed_var(session, "o", "2")
    operand = _ArithOperand(session)
    assert operand.value("3") == 3
    assert operand.value(" -2 ") == -2
    assert operand.value("1+1") == 2
    assert operand.value("i+1") == 2
    assert operand.value("o") == 2
    # An operand that does not evaluate ends the line in bash's words,
    # the reference leading.
    operand.ref = "v"
    with pytest.raises(ExitSignal) as caught:
        operand.value("notanum;")
    assert caught.value.stderr.startswith(b"bash: v: notanum;: ")
    # An assignment is recorded for the door and seen by the operands
    # after it, which is bash binding `${v:x=1:y=x+1}` left to right.
    assert operand.value("x=1") == 1
    assert operand.value("x+1") == 2
    assert [(w.name, w.value) for w in operand.writes] == [("x", "1")]
    assert "x" not in session.env
