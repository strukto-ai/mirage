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


def test_empty_negative_suffix_is_required():
    assert not fnmatch("", "*!(a)x", extglob=True)
    assert fnmatch("x", "*!(a)x", extglob=True)


@pytest.mark.parametrize(
    "name,expected", [("1😀", True), ("😀😀", True), ("a", False)]
)
def test_posix_classes_match_unicode_characters(name, expected):
    assert fnmatch(name, "+([[:digit:]😀])", extglob=True) is expected


def test_empty_negative_repetition_remains_nullable():
    assert fnmatch("", "*+([!a]|!([!a]))", extglob=True)


@pytest.mark.parametrize("pattern", ["+(*)", "*(*)", "+(a|*)", "*+(*)"])
def test_repeated_wildcards_match_long_values(pattern):
    value = "a" * 10000
    assert fnmatch(value, pattern, extglob=True)
    assert not fnmatch(value, pattern + "b", extglob=True)


@pytest.mark.parametrize("operator", ["@", "?", "+", "*"])
def test_deep_extended_groups_use_an_explicit_stack(operator):
    pattern = (operator + "(") * 1200 + "a" + ")" * 1200
    assert fnmatch("a", pattern, extglob=True)
    assert not fnmatch("b", pattern, extglob=True)


def test_sparse_repetition_keeps_discovery_linear():
    assert fnmatch("a" * 16000, "+(aa)", extglob=True)
    assert not fnmatch("a" * 16001, "+(aa)", extglob=True)


@pytest.mark.parametrize(
    "char,expected", [("5", True), ("z", False), ("a", False)]
)
def test_invalid_range_does_not_erase_a_posix_class(char, expected):
    assert fnmatch(char, "[[:digit:]z-a]", extglob=True) == expected


@pytest.mark.parametrize(
    "pattern", ["+(*(aa))", "+(?(aa))", "*(+(aa)|b)", "+(@(*(aa)|b))"]
)
def test_nested_repetitions_share_active_states(pattern):
    assert fnmatch("a" * 16000, pattern, extglob=True)
    assert not fnmatch("a" * 16001, pattern, extglob=True)
    assert not fnmatch("a" * 16000 + "c", pattern, extglob=True)


def test_negative_suffixes_share_scheduled_offsets():
    assert fnmatch("a" * 16000, "*!(a)", extglob=True)
    assert not fnmatch("a" * 16000, "*!(*)", extglob=True)
