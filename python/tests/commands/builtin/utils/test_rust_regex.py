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

from mirage.commands.builtin.utils.rust_regex import (
    PCRE2_HINT,
    RustRegexError,
    translate_rust,
    whole_line,
    whole_word,
)


def find_all(patterns: list[str], text: str, ignore_case: bool = False):
    translated = translate_rust(patterns, ignore_case)
    flags = re.IGNORECASE if translated.ignore_case else 0
    return [m.group() for m in re.finditer(translated.source, text, flags)]


# Every row measured with ripgrep 14.1.1 (`printf TEXT | rg -o PATTERN`).
@pytest.mark.parametrize(
    "pattern,text,found",
    [
        (r"\<w[a-z]*", "word sword", ["word"]),
        (r"[a-z]*d\>", "word sword", ["word", "sword"]),
        (r"\b{start}w[a-z]*", "word sword", ["word"]),
        (r"[a-z]*d\b{end}", "word sword", ["word", "sword"]),
        (r"\b{start-half}w[a-z]*", "word sword", ["word"]),
        (r"\w+", "aé١", ["aé١"]),
        (r"\d+", "a٣5", ["٣5"]),
        (r"\s", "a\xa0b", ["\xa0"]),
        (r"\bb", "é b", ["b"]),
        (r"\bb", "éb", []),
        (r"[[:alpha:]]+", "aé1", ["a"]),
        (r"(?-u:\w)+", "aé", ["a"]),
        (r"\x41", "A", ["A"]),
        (r"\u{41}", "A", ["A"]),
        (r"\U00000041", "A", ["A"]),
        ("(?i)a", "Aa", ["A", "a"]),
        ("(?i:a)A", "Aa", []),
        ("a(?i)a", "aA", ["aA"]),
        (r"\Aab\z", "ab", ["ab"]),
        ("[a-z&&[^b]]", "ab", ["a"]),
        ("[a-c--b]", "abc", ["a", "c"]),
        ("[a-c~~b-d]", "abc", ["a"]),
        ("[]]", "a]b", ["]"]),
        ("[[:^alpha:]c]", "abc", ["c"]),
        (r"\pL+", "aé1", ["aé"]),
        (r"\PL", "aé1", ["1"]),
        (r"\p{Lu}", "Éé1", ["É"]),
        (r"\p{gc=Nd}", "a1", ["1"]),
        (r"\p{decimal number}", "a1", ["1"]),
        ("a+?", "aaa", ["a", "a", "a"]),
        ("a{2}?", "aaa", ["aa"]),
        ("(?U)a+", "aaa", ["a", "a", "a"]),
        ("(?x) a b ", "ab", ["ab"]),
        (r"(?x)a\ b", "a b", ["a b"]),
        (r"\-", "a-b", ["-"]),
        (r"\~", "a~b", ["~"]),
        ("x{2}{3}", "xxxxxx", ["xxxxxx"]),
        ("a++", "ab", ["a"]),
        ("(?P<x>a)", "aa", ["a", "a"]),
        ("(?<x>a)a", "aa", ["aa"]),
        ("(?P<a.b>a)", "ab", ["a"]),
        (r"\a", "a\x07b", ["\x07"]),
        ("[&&a]", "ab", []),
        ("[-a]", "a-", ["a", "-"]),
        ("(?i)[^a]", "Ab", ["b"]),
        ("(?i:[B])", "ab", ["b"]),
        ("^*a", "*a", ["a"]),
        (r"\b+a", "ab", ["a"]),
    ],
)
def test_matches_as_ripgrep(pattern, text, found):
    assert find_all([pattern], text) == found


# ripgrep folds with Unicode simple case folding (`rg -io`).
@pytest.mark.parametrize(
    "pattern,text,found",
    [
        ("é", "Éé", ["É", "é"]),
        ("k", "K\u212a", ["K", "\u212a"]),
        ("s", "\u017f", ["\u017f"]),
        ("ss", "Straße", []),
    ],
)
def test_case_folding(pattern, text, found):
    assert find_all([pattern], text, ignore_case=True) == found


def test_scoped_case_folding_is_spelled_out():
    translated = translate_rust(["a(?-i)b"], ignore_case=True)
    assert not translated.ignore_case
    assert re.search(translated.source, "Ab")
    assert not re.search(translated.source, "AB")


def rendered(
    message: str, display: str, carets: str, hint: bool = False
) -> str:
    text = f"regex parse error:\n    {display}\n    {carets}\nerror: {message}"
    return text + "\n\n" + PCRE2_HINT if hint else text


LOOK = "look-around, including look-ahead and look-behind, is not supported"


@pytest.mark.parametrize(
    "patterns,message,display,carets,hint",
    [
        ([r"(?<=id=)\d+"], LOOK, r"(?:(?<=id=)\d+)", "   ^^^^", True),
        (["id=(?=4)"], LOOK, "(?:id=(?=4))", "      ^^^", True),
        (["x|(?<!a)|y"], LOOK, "(?:x|(?<!a)|y)", "     ^^^^", True),
        (["a", "(?=a)"], LOOK, "(?:a)|(?:(?=a))", "         ^^^", True),
        (
            [r"(a)\1"],
            "backreferences are not supported",
            r"(?:(a)\1)",
            "      ^^",
            True,
        ),
        (
            [r"[\1]"],
            "backreferences are not supported",
            r"(?:[\1])",
            "    ^^",
            True,
        ),
        (
            [r"\0"],
            "backreferences are not supported",
            r"(?:\0)",
            "   ^^",
            True,
        ),
        (["("], "unclosed group", "(?:()", "^", False),
        (["a)"], "unopened group", "(?:a))", "     ^", False),
        (["[a"], "unclosed character class", "(?:[a)", "   ^", False),
        (["[^"], "unclosed character class", "(?:[^)", "   ^^", False),
        (["[]"], "unclosed character class", "(?:[])", "   ^^", False),
        (["[[]"], "unclosed character class", "(?:[[])", "    ^^", False),
        ([r"a\\"[:-1]], "unclosed group", "(?:a\\)", "^", False),
        (
            ["*a"],
            "repetition operator missing expression",
            "(?:*a)",
            "   ^",
            False,
        ),
        (
            ["a|*b"],
            "repetition operator missing expression",
            "(?:a|*b)",
            "     ^",
            False,
        ),
        (
            ["(?)a"],
            "repetition operator missing expression",
            "(?:(?)a)",
            "    ^",
            False,
        ),
        (
            ["{1}"],
            "repetition operator missing expression",
            "(?:{1})",
            "   ^",
            False,
        ),
        (
            ["a{2,1}"],
            "invalid repetition count range, the start must be <= the end",
            "(?:a{2,1})",
            "    ^^^^^",
            False,
        ),
        (
            ["a{,2}"],
            "repetition quantifier expects a valid decimal",
            "(?:a{,2})",
            "     ^",
            False,
        ),
        (
            ["a{"],
            "repetition quantifier expects a valid decimal",
            "(?:a{)",
            "     ^",
            False,
        ),
        (["a{1"], "unclosed counted repetition", "(?:a{1)", "    ^^", False),
        (
            ["a{99999999999}"],
            "decimal literal invalid",
            "(?:a{99999999999})",
            "     ^^^^^^^^^^^",
            False,
        ),
        (
            [r"\d\Z"],
            "unrecognized escape sequence",
            r"(?:\d\Z)",
            "     ^^",
            False,
        ),
        ([r"\e"], "unrecognized escape sequence", r"(?:\e)", "   ^^", False),
        (
            [r"\Qa\E"],
            "unrecognized escape sequence",
            r"(?:\Qa\E)",
            "   ^^",
            False,
        ),
        (["(?z)a"], "unrecognized flag", "(?:(?z)a)", "     ^", False),
        (["a(?#c)b"], "unrecognized flag", "(?:a(?#c)b)", "      ^", False),
        (["(?P=x)"], "unrecognized flag", "(?:(?P=x))", "     ^", False),
        (
            ["(?i-)a"],
            "dangling flag negation operator",
            "(?:(?i-)a)",
            "      ^",
            False,
        ),
        (["(?ii)a"], "duplicate flag", "(?:(?ii)a)", "     ^^", False),
        (
            ["(?P<>a)"],
            "empty capture group name",
            "(?:(?P<>a))",
            "       ^",
            False,
        ),
        (
            ["(?P<a"],
            "invalid capture group character",
            "(?:(?P<a)",
            "        ^",
            False,
        ),
        (
            ["(?P<1x>a)"],
            "invalid capture group character",
            "(?:(?P<1x>a))",
            "       ^",
            False,
        ),
        (
            ["(?P<x>a)(?P<x>b)"],
            "duplicate capture group name",
            "(?:(?P<x>a)(?P<x>b))",
            "       ^       ^",
            False,
        ),
        (
            [r"[\b]"],
            "invalid escape sequence found in character class",
            r"(?:[\b])",
            "    ^^",
            False,
        ),
        (
            [r"[\d-z]"],
            "invalid range boundary, must be a literal",
            r"(?:[\d-z])",
            "    ^^",
            False,
        ),
        (
            [r"[a-\d]"],
            "invalid range boundary, must be a literal",
            r"(?:[a-\d])",
            "      ^^",
            False,
        ),
        (
            ["[z-a]"],
            "invalid character class range, the start must be <= the end",
            "(?:[z-a])",
            "    ^^^",
            False,
        ),
        ([r"\x4"], "invalid hexadecimal digit", r"(?:\x4)", "      ^", False),
        (
            [r"\x{}"],
            "hexadecimal literal empty",
            r"(?:\x{})",
            "     ^^",
            False,
        ),
        (
            [r"\x{110000}"],
            "hexadecimal literal is not a Unicode scalar value",
            r"(?:\x{110000})",
            "      ^^^^^^",
            False,
        ),
        (
            [r"\p{L"],
            "incomplete escape sequence, reached end of pattern prematurely",
            r"(?:\p{L)",
            "        ^",
            False,
        ),
        (["(?x)a # c"], "unclosed group", "(?:(?x)a # c)", "^", False),
    ],
)
def test_refusals_in_ripgreps_words(patterns, message, display, carets, hint):
    with pytest.raises(RustRegexError) as caught:
        translate_rust(patterns)
    assert str(caught.value) == rendered(message, display, carets, hint)


def test_an_unknown_property_is_refused_loudly():
    with pytest.raises(RustRegexError) as caught:
        translate_rust([r"\p{Greek}"])
    assert "not supported in mirage" in caught.value.message


def test_word_and_line_bounds():
    word = whole_word(translate_rust(["a-"]).source)
    assert not re.search(word, "a-b")
    assert re.search(whole_word(translate_rust(["a"]).source), "a b")
    line = whole_line(translate_rust(["a|ab"]).source, False)
    assert re.search(line, "ab")
    assert not re.search(line, "abc")
