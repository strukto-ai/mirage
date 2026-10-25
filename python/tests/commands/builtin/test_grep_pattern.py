import pytest

from mirage.commands.builtin.grep_pattern import (
    NEVER_MATCH,
    compile_pattern,
    line_selected,
    matcher_syntax,
    merge_pattern_list,
    pattern_warnings,
)
from mirage.commands.builtin.types import RegexSyntax
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.shell.bytes import byte_view


def test_single_pattern_keeps_regex_semantics():
    pat = compile_pattern("fo+")
    assert line_selected(pat, "foo")
    assert not line_selected(pat, "f")


def test_single_fixed_string_escapes():
    pat = compile_pattern("a.b", fixed_string=True)
    assert line_selected(pat, "xa.by")
    assert not line_selected(pat, "axb")


def test_newline_separated_patterns_match_any():
    pat = compile_pattern("foo\nbar")
    assert line_selected(pat, "a foo b")
    assert line_selected(pat, "a bar b")
    assert not line_selected(pat, "baz")


def test_newline_separated_regex_alternation_grouping():
    pat = compile_pattern("ab+\ncd")
    assert line_selected(pat, "abb")
    assert line_selected(pat, "xcdy")
    assert not line_selected(pat, "ax")


def test_newline_separated_fixed_strings_escape_each():
    pat = compile_pattern("a.b\nc+", fixed_string=True)
    assert line_selected(pat, "xa.by")
    assert line_selected(pat, "c+")
    assert not line_selected(pat, "axb")
    assert not line_selected(pat, "cc")


def test_newline_separated_whole_word_applies_per_pattern():
    pat = compile_pattern("foo\nbar", whole_word=True)
    assert line_selected(pat, "a foo b")
    assert line_selected(pat, "bar.")
    assert not line_selected(pat, "foobar")


def test_newline_separated_ignore_case():
    pat = compile_pattern("foo\nbar", ignore_case=True)
    assert line_selected(pat, "FOO")
    assert line_selected(pat, "Bar")


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
    assert not line_selected(pat, "")
    assert not line_selected(pat, "anything")


class TestCompilePattern:
    def test_basic(self):
        pat = compile_pattern("hello")
        assert line_selected(pat, "hello world")

    def test_ignore_case(self):
        pat = compile_pattern("hello", ignore_case=True)
        assert line_selected(pat, "HELLO")

    def test_fixed_string(self):
        pat = compile_pattern("a.b", fixed_string=True)
        assert not line_selected(pat, "axb")
        assert line_selected(pat, "a.b")

    def test_whole_word(self):
        pat = compile_pattern("foo", whole_word=True)
        assert not line_selected(pat, "foobar")
        assert line_selected(pat, "foo bar")


# Every row measured against GNU grep 3.11 under LC_ALL=C, which is the
# locale mirage renders in: `grep -w ab` on `éab` and `grep -w a` on `aé`
# both select the line, while `grep -i k` on U+212A and `grep -i s` on
# U+017F select nothing. The subjects are the byte views of their UTF-8.
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
    pattern, subject, ignore_case, whole_word, selected
):
    pat = compile_pattern(
        pattern,
        ignore_case=ignore_case,
        whole_word=whole_word,
        syntax=RegexSyntax.BASIC,
    )
    assert line_selected(pat, byte_view(subject)) is selected


def test_word_class_stays_ascii_in_an_extended_expression():
    # -E takes the same compile, so `\w` must not grow a Unicode meaning
    # there either.
    pat = compile_pattern(r"\w", syntax=RegexSyntax.EXTENDED)
    assert not line_selected(pat, byte_view("é"))
    assert line_selected(pat, "a")


# GNU grep 3.11: one matcher, and two different ones are refused.
@pytest.mark.parametrize(
    "flags,syntax",
    [
        ({}, RegexSyntax.BASIC),
        ({"basic_regexp": True}, RegexSyntax.BASIC),
        ({"extended_regexp": True}, RegexSyntax.EXTENDED),
        ({"perl_regexp": True}, RegexSyntax.PERL),
        ({"fixed_strings": True}, RegexSyntax.BASIC),
    ],
)
def test_matcher_syntax(flags, syntax):
    assert matcher_syntax(FlagView(flags, spec=SPECS["grep"])) is syntax


@pytest.mark.parametrize(
    "flags",
    [
        {"extended_regexp": True, "perl_regexp": True},
        {"fixed_strings": True, "perl_regexp": True},
        {"basic_regexp": True, "perl_regexp": True},
        {"extended_regexp": True, "fixed_strings": True},
    ],
)
def test_two_matchers_conflict(flags):
    with pytest.raises(UsageError) as caught:
        matcher_syntax(FlagView(flags, spec=SPECS["grep"]))
    assert str(caught.value) == "grep: conflicting matchers specified"


def test_only_an_extended_expression_warns():
    extended = compile_pattern("*a\n?b", syntax=RegexSyntax.EXTENDED)
    assert pattern_warnings(extended) == (
        b"grep: warning: * at start of expression\n"
        b"grep: warning: ? at start of expression\n"
    )
    basic = compile_pattern("*a", syntax=RegexSyntax.BASIC)
    assert pattern_warnings(basic) == b""


def test_perl_takes_one_pattern():
    with pytest.raises(UsageError) as caught:
        compile_pattern("a\nb", syntax=RegexSyntax.PERL)
    assert str(caught.value) == (
        "grep: the -P option only supports a single pattern"
    )
    assert line_selected(
        compile_pattern(r"\d+", syntax=RegexSyntax.PERL), "x45"
    )
    word = compile_pattern("a", whole_word=True, syntax=RegexSyntax.PERL)
    assert not line_selected(word, "ab")
    assert line_selected(word, "a b")


def test_perl_refusals_are_pcre2s():
    with pytest.raises(UsageError) as caught:
        compile_pattern("(", syntax=RegexSyntax.PERL)
    assert str(caught.value) == "grep: missing closing parenthesis"
