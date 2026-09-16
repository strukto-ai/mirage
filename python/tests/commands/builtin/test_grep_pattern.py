import pytest

from mirage.commands.builtin.grep_pattern import (NEVER_MATCH, compile_pattern,
                                                  merge_pattern_list)


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


class TestCompilePattern:

    def test_basic(self):
        pat = compile_pattern("hello")
        assert pat.search("hello world")

    def test_ignore_case(self):
        pat = compile_pattern("hello", ignore_case=True)
        assert pat.search("HELLO")

    def test_fixed_string(self):
        pat = compile_pattern("a.b", fixed_string=True)
        assert not pat.search("axb")
        assert pat.search("a.b")

    def test_whole_word(self):
        pat = compile_pattern("foo", whole_word=True)
        assert not pat.search("foobar")
        assert pat.search("foo bar")


# Every row measured against GNU grep 3.11 under LC_ALL=C, which is the
# locale mirage renders in: `grep -w ab` on `éab` and `grep -w a` on `aé`
# both select the line, while `grep -i k` on U+212A and `grep -i s` on
# U+017F select nothing. python's own defaults answer the opposite way on
# all four, so the pattern is compiled with `re.ASCII`.
@pytest.mark.parametrize(
    "pattern, subject, ignore_case, whole_word, selected",
    [
        ("ab", "éab", False, True, True),
        ("a", "aé", False, True, True),
        ("k", "K", True, False, False),
        ("s", "ſ", True, False, False),
        ("ab", "xab", False, True, False),
        ("k", "K", True, False, True),
    ],
)
def test_ascii_semantics_for_word_boundaries_and_case_folding(
        pattern, subject, ignore_case, whole_word, selected):
    pat = compile_pattern(pattern,
                          ignore_case=ignore_case,
                          whole_word=whole_word,
                          basic=True)
    assert bool(pat.search(subject)) is selected


def test_word_class_stays_ascii_in_an_extended_expression():
    # -E takes the same compile, so `\w` must not grow a Unicode meaning
    # there either.
    pat = compile_pattern(r"\w", basic=False)
    assert not pat.search("é")
    assert pat.search("a")
