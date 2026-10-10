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

from mirage.utils.fnmatch import _normalize_negation, fnmatch, fnmatchcase


@pytest.mark.parametrize(
    "name,pattern,expected",
    [
        ("c.txt", "[!ab].txt", True),
        ("a.txt", "[!ab].txt", False),
        ("c.txt", "[^ab].txt", True),
        ("a.txt", "[^ab].txt", False),
        ("b.txt", "[ab].txt", True),
        ("c.txt", "[a-c].txt", True),
        ("d.txt", "[a-c].txt", False),
        ("hello", "h*o", True),
        ("hello", "h?llo", True),
        ("Hello", "hello", False),
        ("x", "[x^]", True),
        ("^", "[x^]", True),
        ("😀.txt", "?.txt", True),
    ],
)
def test_fnmatch(name, pattern, expected):
    assert fnmatch(name, pattern) is expected


@pytest.mark.parametrize(
    "name,pattern,expected",
    [
        ("a.txt", "[^a]*", True),
        ("^x", "[^a]*", True),
        ("b.txt", "[^a]*", False),
        ("b.txt", "[!a]*", True),
        ("😀.txt", "?.txt", True),
    ],
)
def test_fnmatchcase_keeps_a_leading_caret_literal(name, pattern, expected):
    assert fnmatchcase(name, pattern) is expected


def test_normalize_negation_rewrites_class_openers():
    assert _normalize_negation("[^ab]*") == "[!ab]*"
    assert _normalize_negation("x[^y]") == "x[!y]"
    assert _normalize_negation("[!ab]") == "[!ab]"
    assert _normalize_negation("plain") == "plain"


def test_caret_not_first_in_class_stays_literal():
    assert fnmatch("^", "[a^]") is True
    assert fnmatch("b", "[a^]") is False


EXTGLOB_NAMES = [
    "",
    "a",
    "b",
    "c",
    "ab",
    "abc",
    "bb",
    "aa",
    "ac",
    "a(b)",
    "a(b|d)",
    "a|b",
    "123",
    "😀",
    "a\nb",
]


@pytest.mark.parametrize(
    "pattern,hits",
    [
        ("@(a|b)", ["a", "b"]),
        ("?(a|b)", ["", "a", "b"]),
        ("*(a|b)", ["", "a", "b", "ab", "bb", "aa"]),
        ("+(a|b)", ["a", "b", "ab", "bb", "aa"]),
        (
            "!(a|b)",
            [
                "",
                "c",
                "ab",
                "abc",
                "bb",
                "aa",
                "ac",
                "a(b)",
                "a(b|d)",
                "a|b",
                "123",
                "😀",
                "a\nb",
            ],
        ),
        (
            "!(a)*",
            [
                "",
                "a",
                "b",
                "c",
                "ab",
                "abc",
                "bb",
                "aa",
                "ac",
                "a(b)",
                "a(b|d)",
                "a|b",
                "123",
                "😀",
                "a\nb",
            ],
        ),
        ("a!(b)c", ["ac"]),
        ("@(a|+(b|c))", ["a", "b", "c", "bb"]),
        (
            "*(!(a))",
            [
                "",
                "b",
                "c",
                "ab",
                "abc",
                "bb",
                "aa",
                "ac",
                "a(b)",
                "a(b|d)",
                "a|b",
                "123",
                "😀",
                "a\nb",
            ],
        ),
        ("+(?(a))", ["", "a", "aa"]),
        ("@(|a)", ["", "a"]),
        (
            "!()",
            [
                "a",
                "b",
                "c",
                "ab",
                "abc",
                "bb",
                "aa",
                "ac",
                "a(b)",
                "a(b|d)",
                "a|b",
                "123",
                "😀",
                "a\nb",
            ],
        ),
        ("@(a(b)|c)", ["c", "a(b)"]),
        ("@(a(b|d)|c)", ["c", "a(b|d)"]),
        ("+([[:digit:]])", ["123"]),
        ("@(😀|a)", ["a", "😀"]),
        ("@([!a]|ab)", ["b", "c", "ab", "😀"]),
        ("@(a[|]b|c)", ["c", "a|b"]),
    ],
)
def test_extglob_matches_gnu_bash(pattern, hits):
    for name in EXTGLOB_NAMES:
        assert fnmatch(name, pattern, extglob=True) == (name in hits), name


@pytest.mark.parametrize(
    "name,pattern,expected",
    [
        (".h", "@(.h|a)", True),
        (".h", "?(.h)", True),
        (".h", "*(.h)", True),
        (".h", "!(a)", False),
        (".h", "!(a).h", False),
        (".h", "*(x).h", True),
        (".h", "*.h", False),
        (".h", "@([.]h|a)", False),
        (".h", "@(.*|a)", True),
    ],
)
def test_extglob_pathname_period(name, pattern, expected):
    assert fnmatch(name, pattern, extglob=True, period=True) is expected


def test_extglob_is_opt_in_and_nullable_repetition_terminates():
    assert not fnmatch("a", "@(a|b)")
    assert fnmatch("@(a|b)", "@(a|b)")
    assert fnmatch("a" * 80, "+(?(a))", extglob=True)
    assert not fnmatch("a" * 80 + "b", "+(?(a))", extglob=True)


def test_a_star_hands_a_group_every_tail():
    assert not fnmatch("", "*!(a)x", extglob=True)
    assert fnmatch("x", "*!(a)x", extglob=True)
    assert fnmatch("a", "*!(a)", extglob=True)
    assert fnmatch("", "*+([!a]|!([!a]))", extglob=True)


@pytest.mark.parametrize(
    "pattern,tail,expected",
    [
        ("+(*)", "", True),
        ("+(*)b", "", False),
        ("*(*)", "", True),
        ("+(a|*)b", "", False),
        ("*+(*)", "", True),
        ("+(aa)", "", True),
        ("+(aa)", "a", False),
        ("+(*(aa))", "", True),
        ("+(?(aa))", "a", False),
        ("*(+(aa)|b)", "c", False),
        ("+(@(*(aa)|b))", "", True),
        ("*!(a)", "", True),
        ("*!(*)", "", False),
        ("*!(a*)", "", True),
        ("*!(*a)", "", True),
        ("*!(*b)", "", True),
        ("*!(+(aa))", "a", True),
    ],
)
def test_long_subjects_match_in_linear_time(pattern, tail, expected):
    assert fnmatch("a" * 16000 + tail, pattern, extglob=True) is expected


@pytest.mark.parametrize("operator", ["@", "?", "+", "*"])
def test_deep_extended_groups_use_an_explicit_stack(operator):
    pattern = (operator + "(") * 1200 + "a" + ")" * 1200
    assert fnmatch("a", pattern, extglob=True)
    assert not fnmatch("b", pattern, extglob=True)
