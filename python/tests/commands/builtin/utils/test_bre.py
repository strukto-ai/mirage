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

from mirage.commands.builtin.utils.bre import (BreError, compile_bre,
                                               search_bre, translate_bre)

# Every row below is a differential result against GNU grep 3.11, GNU nl
# 9.4 and GNU expr 9.4 on glibc 2.39 under `LC_ALL=C`: 208 patterns
# crossed with 60 subject lines, zero mismatches in either host. The
# pattern, a subject the unanchored search matches, and one it must not.
# Mirrored row for row in `bre.test.ts`.
SEMANTICS = [
    # The escaping inversion: the escaped spellings are the operators
    # and the bare ones are ordinary characters, which is the exact
    # opposite of what python's engine reads.
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
    ("a}b", "a}b", "ab"),
    # Intervals, including the open low bound glibc reads as zero.
    (r"a\{2,\}", "aaa", "a"),
    (r"xa\{,3\}y", "xy", "xz"),
    (r"xa\{,\}y", "xy", "xz"),
    (r"a\{01\}", "a", "b"),
    (r"^a\{1,2\}b", "aab", "aaab"),
    # A quantifier with nothing in front of it is a literal, not a
    # refusal: glibc has no "nothing to repeat" for a BRE at all.
    ("*abc", "*abc", "abc"),
    ("^*abc", "*abc", "abc"),
    (r"\(*a\)", "*a", "a"),
    (r"a\|*b", "*b", "x"),
    (r"\+", "+", "x"),
    (r"\?", "?", "x"),
    (r"\{1\}", "{1}", "x"),
    (r"\{2,1\}", "{2,1}", "x"),
    (r"\{x\}", "{x}", "x"),
    (r"\{32768\}", "{32768}", "x"),
    # The control that proves the model: the first `\{` is a literal
    # `{`, scanning continues, and the second interval quantifies the
    # `}` the first one left behind.
    (r"\{1\}\{2\}", "{1}}", "{1}"),
    # Anchors are context-dependent. `^` anchors at the start of the
    # pattern, just after `\(` and just after `\|`, and is a literal
    # caret everywhere else -- including straight after another `^`.
    ("^ab", "ab", "xab"),
    ("a^b", "a^b", "ab"),
    (r"\(^ab\)", "ab", "xab"),
    (r"x\|^a", "abc", "^abc"),
    ("^^a", "^abc", "abc"),
    (r"\(^^a\)", "^abc", "abc"),
    (r"\(\^a\)", "^abc", "abc"),
    (r"\b^a", "x^abc", "abc"),
    (r"\(a\)^b", "a^b", "ab"),
    # `$` anchors at the end of the pattern and before `\)` or `\|`.
    ("ab$", "xab", "abc"),
    ("a$b", "a$b", "ab"),
    (r"\(c$\)", "abc", "abcd"),
    (r"c$\|x", "abc", "yz"),
    ("c$$", "abc$", "abc"),
    # Bracket expressions: everything inside is ordinary, a `]` in the
    # first slot is a member, and a backslash is just a backslash.
    ("[]]", "x]y", "xyz"),
    ("[^]]", "x", "]"),
    ("[]a.]", "]", "x"),
    ("[-a]", "-", "b"),
    ("[a-]", "-", "b"),
    ("[a-c-]", "-", "z"),
    ("[a-cd-f]", "e", "z"),
    ("[+?]", "a+b", "ab"),
    (r"[a\]", "\\", "b"),
    ("[[.a.]-z]", "m", "1"),
    ("[a[.b.]-c]", "c", "z"),
    ("[a-[.b.]]", "b", "z"),
    ("[[.a.]]", "a", "b"),
    ("[[=a=]]", "a", "b"),
    ("[a-c[:digit:]]", "9", "zz"),
    ("[[:digit:]a-c]", "9", "zz"),
    # POSIX classes are expanded to their `LC_ALL=C` sets rather than
    # handed over: python would read `[[:alpha:]]` as the set `[:alph]`.
    ("[[:alpha:]]", "abc", "123"),
    ("[[:digit:]]", "a1", "abc"),
    ("[[:space:]]", "a b", "ab"),
    ("[[:punct:]]", "a-b", "ab"),
    ("[[:upper:]]", "aB", "ab"),
    ("[[:alnum:]_]", "_", "-"),
    # GNU's escapes, expanded for the same reason: python's own `\w` is
    # Unicode-aware by default and GNU's is ASCII under `LC_ALL=C`.
    (r"\w\+", "abc", "---"),
    (r"\W", "-", "abc"),
    (r"\s", "a b", "ab"),
    (r"\S", "a", " "),
    (r"\<a", "x a", "xa"),
    (r"a\>", "a x", "ax"),
    (r"\`a", "abc", "xabc"),
    (r"a\'", "xa", "ax"),
    (r"\0", "0", "x"),
    # Backreferences, and an ordinary escaped literal.
    (r"\(a\)\1", "aa", "ab"),
    (r"\(a\)b\1", "aba", "abb"),
    (r"a\.b", "a.b", "axb"),
    ("a.b", "axb", "ab"),
    (r"a\\b", "a\\b", "ab"),
]

# glibc's `regerror` strings, measured through both `expr abc : PAT` and
# `nl -b pPAT`, which answer identically. `Invalid preceding regular
# expression` is absent on purpose: no BRE reaches it.
REFUSALS = [
    ("[", "Invalid regular expression"),
    ("[^", "Invalid regular expression"),
    ("[a", "Unmatched [, [^, [:, [., or [="),
    ("[]", "Unmatched [, [^, [:, [., or [="),
    ("[[", "Unmatched [, [^, [:, [., or [="),
    ("[[:alpha:", "Unmatched [, [^, [:, [., or [="),
    ("[[:alpha:]", "Unmatched [, [^, [:, [., or [="),
    ("[.", "Unmatched [, [^, [:, [., or [="),
    ("[=", "Unmatched [, [^, [:, [., or [="),
    ("[-", "Unmatched [, [^, [:, [., or [="),
    ("[a-", "Unmatched [, [^, [:, [., or [="),
    (r"\(", "Unmatched ( or \\("),
    (r"a\(b", "Unmatched ( or \\("),
    (r"\)", "Unmatched ) or \\)"),
    (r"a\)", "Unmatched ) or \\)"),
    ("\\", "Trailing backslash"),
    (r"\1", "Invalid back reference"),
    (r"\9", "Invalid back reference"),
    (r"\(a\)\2", "Invalid back reference"),
    (r"\(a\1\)", "Invalid back reference"),
    ("[[:bogus:]]", "Invalid character class name"),
    ("[[.ab.]]", "Invalid collation character"),
    ("[[..]]", "Invalid collation character"),
    ("[[=ab=]]", "Invalid collation character"),
    (r"a\{1,", "Unmatched \\{"),
    (r"a\{\}", "Invalid content of \\{\\}"),
    (r"a\{x\}", "Invalid content of \\{\\}"),
    (r"a\{ 1\}", "Invalid content of \\{\\}"),
    (r"a\{-1\}", "Invalid content of \\{\\}"),
    (r"a\{2,1\}", "Invalid content of \\{\\}"),
    (r"a\{1,,2\}", "Invalid content of \\{\\}"),
    (r"a\{1,2,3\}", "Invalid content of \\{\\}"),
    # A newline inside the body is not a bound either. python's `$` also
    # matches just before a trailing newline, so `INTERVAL_RE.match` accepted
    # these four where GNU refuses them
    # (`expr aa : 'a\{2<newline>\}'` is `expr: Invalid content of \{\}`,
    # exit 2) and where the TypeScript twin already refused them.
    ("a\\{2\n\\}", "Invalid content of \\{\\}"),
    ("a\\{\n\\}", "Invalid content of \\{\\}"),
    ("a\\{2,\n\\}", "Invalid content of \\{\\}"),
    ("a\\{1,2\n\\}", "Invalid content of \\{\\}"),
    (r"a\{32768\}", "Regular expression too big"),
    (r"a\{0,32768\}", "Regular expression too big"),
    (r"a\{100000\}", "Regular expression too big"),
    # `Invalid range end` is about the KIND of endpoint, not its order:
    # a class or an equivalence class on either side is refused, and so
    # is a `-x` that follows an already-closed range.
    ("[[:alpha:]-z]", "Invalid range end"),
    ("[z-[:alpha:]]", "Invalid range end"),
    ("[a-[:alpha:]]", "Invalid range end"),
    ("[[=a=]-z]", "Invalid range end"),
    ("[a-[=b=]]", "Invalid range end"),
    ("[a-c-e]", "Invalid range end"),
    ("[a-b-c]", "Invalid range end"),
    ("[z-a-c]", "Invalid range end"),
]

# A collating element IS a legal range endpoint, and a trailing `-` is a
# member rather than a second range end. The mirror of the four
# `Invalid range end` rows above.
LEGAL_RANGES = [
    "[[.a.]-z]", "[a[.b.]-c]", "[a-[.b.]]", "[a-c-]", "[a-cd-f]", "[a-]",
    "[-a]", "[--a]", "[-a-c]", "[a-c[:digit:]]", "[[:digit:]a-c]"
]

# The one construct the two GNU dialects read differently. grep and sed
# refuse an inverted plain-character range; expr and nl compile it to an
# empty set, which matches nothing (or, negated, any one character).
INVERTED_RANGES = [
    "[z-a]", "[9-0]", "[b-a]", "[a--]", "[^z-a]", "[9-0]x", "[[.z.]-[.a.]]"
]

# The host source, spelled out where the inversion is the whole point.
TRANSLATIONS = [
    (r"\(a\)", "(a)", 1),
    ("(a)", r"\(a\)", 0),
    (r"a\|b", "a|b", 0),
    ("a|b", r"a\|b", 0),
    (r"a\+", "a+", 0),
    ("a+", r"a\+", 0),
    (r"a\{2,3\}", "a{2,3}", 0),
    ("a{2}", r"a\{2\}", 0),
    ("*a", r"\*a", 0),
    ("[[:alpha:]]", "[A-Za-z]", 0),
    (r"\w", "[0-9A-Za-z_]", 0),
    (r"\(^a\)", "(^a)", 1),
    ("^^a", r"^\^a", 0),
    ("[z-a]", "[^\\s\\S]", 0),
    ("[^z-a]", "[\\s\\S]", 0),
    (r"\(a\)\(b\)", "(a)(b)", 2),
    ("", "", 0),
]


@pytest.mark.parametrize("pattern,hit,miss", SEMANTICS)
def test_search_matches_gnu_basic_expression_semantics(pattern, hit, miss):
    compiled = search_bre(pattern)
    assert compiled.search(hit), f"{pattern!r} should match {hit!r}"
    assert not compiled.search(miss), f"{pattern!r} should miss {miss!r}"


@pytest.mark.parametrize("pattern,message", REFUSALS)
def test_a_refused_pattern_is_worded_as_glibc_words_it(pattern, message):
    with pytest.raises(BreError) as caught:
        translate_bre(pattern)
    assert str(caught.value) == message


@pytest.mark.parametrize("pattern", LEGAL_RANGES)
def test_a_collating_endpoint_and_a_trailing_dash_compile(pattern):
    assert search_bre(pattern) is not None


@pytest.mark.parametrize("pattern", INVERTED_RANGES)
def test_an_inverted_range_is_an_empty_set_for_expr_and_nl(pattern):
    # Both host engines refuse the range outright, so the empty set has
    # to be spelled out rather than left to them.
    assert translate_bre(pattern) is not None


@pytest.mark.parametrize("pattern", INVERTED_RANGES)
def test_an_inverted_range_is_refused_in_greps_dialect(pattern):
    with pytest.raises(BreError) as caught:
        translate_bre(pattern, True)
    assert str(caught.value) == "Invalid range end"


def test_an_inverted_range_matches_nothing_and_its_negation_matches_one():
    assert not search_bre("[z-a]").search("z")
    assert not search_bre("[9-0]x").search("x")
    assert search_bre("[^z-a]").search("q")
    assert not search_bre("[^z-a]").search("")


@pytest.mark.parametrize("pattern,source,groups", TRANSLATIONS)
def test_the_host_source_inverts_the_escaping(pattern, source, groups):
    assert translate_bre(pattern) == (source, groups)


def test_the_anchored_entry_point_is_the_one_expr_uses():
    # `expr abc : 'b'` is 0: `re_match` anchors at position 0.
    compiled, _ = compile_bre("b")
    assert compiled.match("abc") is None
    assert compile_bre("a")[0].match("abc") is not None


def test_the_unanchored_entry_point_is_the_one_nl_uses():
    # `printf 'foo\n' | nl -b po` numbers the line: `re_search` does not
    # anchor. The two entry points differ only in that.
    assert search_bre("o").search("foo")
    assert not search_bre("^o").search("foo")


def test_a_dollar_anchor_does_not_admit_a_trailing_newline():
    # python's `$` also matches just before a trailing newline, which
    # GNU's does not, so the anchor is emitted as `\Z`.
    assert translate_bre("ab$") == ("ab\\Z", 0)
    assert not search_bre("b$").search("ab\n")


def test_a_word_class_is_ascii_rather_than_unicode():
    # python's own `\w` matches `é`; GNU's under `LC_ALL=C` does not.
    assert not search_bre(r"\w").search("é")
    assert search_bre(r"\W").search("é")


def test_stacked_quantifiers_are_wrapped_rather_than_refused():
    # glibc reads `a**` as `(a*)*`; both host engines refuse a bare
    # second quantifier.
    assert search_bre("a**").search("aaa")
    assert search_bre("a**").search("")


def test_the_dup_ceiling_is_glibcs_not_the_hosts():
    # RE_DUP_MAX is 32767: either bound compiles at it and is refused
    # one past it, where both host engines would take far more.
    assert search_bre(r"a\{0,32767\}").search("a")
    with pytest.raises(BreError) as caught:
        translate_bre(r"a\{32768\}")
    assert str(caught.value) == "Regular expression too big"


def test_the_group_count_survives_a_failed_match():
    # It is what tells `:` whether to answer with group 1 or with the
    # match length, and a failed match has no match object to ask.
    compiled, groups = compile_bre(r"\(x\)")
    assert groups == 1
    assert compiled.match("abc") is None
