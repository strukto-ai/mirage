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

from mirage.rs.glob import Glob
from mirage.utils.fnmatch import fnmatch, fnmatchcase


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


@pytest.mark.parametrize(
    "name,pattern,expected",
    [
        ("c", "[^ab]*", True),
        ("a", "[^ab]*", False),
        ("^", "[a^]", True),
        ("b", "[a^]", False),
        ("^", "[[^b]", True),
        ("!", "[[^b]", False),
        ("]", "[^]a]", False),
        ("[^ab", "[^ab", True),
        ("[^]", "[^]", True),
    ],
)
def test_caret_negates_only_where_a_class_opens(name, pattern, expected):
    assert fnmatch(name, pattern) is expected


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


def test_matcher_end_reads_every_offset_in_linear_time():
    match = Glob("*b")
    assert (match.end("abcab", 0), match.end("abcab", 0, longest=False)) == (
        5,
        2,
    )
    assert (match.end("abcab", 2), match.end("abcab", 5)) == (5, None)
    blank = Glob("*b")
    subject = " " * 16000
    assert all(blank.end(subject, i) is None for i in range(16001))


@pytest.mark.parametrize(
    "name,pattern,expected",
    [
        ("ab" * 16000, "*a", (None, None)),
        ("ab" * 16000, "a*", (31998, 0)),
        ("xab", "@(b|ab)", (2, 1)),
        ("ba", "+(@(a|b))", (1, 0)),
        ("xa)", "!(a)", (3, 0)),
        ("xa(b)|c", "(b)|c", (2, 2)),
        ("xa(b)", "@(a(b)|z)", (1, 1)),
        ("x[a", "[a", (1, 1)),
        ("x|)", "[)|]", (2, 2)),
        ("\udcff\ud83d", "*", (2, 0)),
        ("\udcff\ud83d", "\ud83d", (1, 1)),
        ("x\udcff\ud83d", "\udcff\ud83d", (1, 1)),
    ],
)
def test_suffix_start_runs_the_reversed_pattern_once(name, pattern, expected):
    glob = Glob(pattern, True)
    shortest = glob.suffix(name, longest=False)
    assert (shortest, glob.suffix(name)) == expected


@pytest.mark.parametrize("operator", ["@", "?", "+", "*"])
def test_deep_extended_groups_use_an_explicit_stack(operator):
    pattern = (operator + "(") * 1200 + "a" + ")" * 1200
    assert fnmatch("a", pattern, extglob=True)
    assert not fnmatch("b", pattern, extglob=True)


@pytest.mark.parametrize(
    "name,pattern,ends,suffix",
    [
        (
            "a😀\udcffb",
            "?",
            [(1, 1), (2, 2), (3, 3), (4, 4), (None, None)],
            (3, 3),
        ),
        (
            "a😀\udcffb",
            "+(?)",
            [(1, 4), (2, 4), (3, 4), (4, 4), (None, None)],
            (3, 0),
        ),
        (
            "a😀\udcffb",
            "?b",
            [(None, None), (None, None), (4, 4), (None, None), (None, None)],
            (2, 2),
        ),
        (
            "x\udcff😀",
            "@(😀|\udcff😀)",
            [(None, None), (3, 3), (3, 3), (None, None)],
            (2, 1),
        ),
    ],
)
def test_match_extents_count_characters_and_preserve_raw_bytes(
    name, pattern, ends, suffix
):
    match = Glob(pattern, True)
    assert [
        (match.end(name, i, longest=False), match.end(name, i))
        for i in range(len(name) + 1)
    ] == ends
    assert (
        match.suffix(name, longest=False),
        match.suffix(name),
    ) == suffix


@pytest.mark.parametrize("index,literal", enumerate("*?[@+!()|"))
def test_quoting_sentinels_are_literal_in_and_out_of_classes(index, literal):
    quoted = chr(0xFDD0 + index)
    assert fnmatch(literal, quoted, extglob=True)
    assert not fnmatch("x", quoted, extglob=True)
    assert fnmatch(literal, "[" + quoted + "]", extglob=True)
    assert not fnmatch("x", "[" + quoted + "]", extglob=True)


@pytest.mark.parametrize(
    "name,pattern,expected",
    [
        ("5", "[[:digit:]z-a]", True),
        ("z", "[[:digit:]z-a]", False),
        ("a", "[[:digit:]z-a]", False),
        ("b", "[z-ab]", True),
        ("-", "[z-ab]", False),
        ("b", "[!z-a]", True),
        ("é", "[[:alpha:]]", False),
        ("١", "[[:digit:]]", False),
        ("\u00a0", "[[:space:]]", False),
        ("\udcff", "[[:print:]]", False),
        ("\udcff", "[!a]", True),
        ("\ud83d", "?", True),
    ],
)
def test_c_locale_classes_raw_bytes_and_descending_ranges(
    name, pattern, expected
):
    assert fnmatch(name, pattern, extglob=True) is expected


@pytest.mark.parametrize("pattern", ["[a--!]", "[a-!!]", "[a-^!]"])
def test_fnmatchcase_normalizes_invalid_ranges_before_negation(pattern):
    assert fnmatchcase("a", pattern)
    assert not fnmatchcase("", pattern)
