import re

import pytest

from mirage.commands.builtin import grep_pushdown
from mirage.commands.builtin.constants import PatternType
from mirage.types import PathSpec


def test_classify_pattern_newline_list_is_regex():
    assert (
        grep_pushdown.classify_pattern("foo\nbar", False) == PatternType.REGEX
    )
    assert (
        grep_pushdown.classify_pattern("foo\nbar", True) == PatternType.REGEX
    )
    assert (
        grep_pushdown.classify_pattern("foo bar", False) == PatternType.SIMPLE
    )


@pytest.mark.parametrize(
    "pattern,fixed,expected",
    [
        ("abc", False, True),
        ("a-b_c.d", False, False),
        ("plain text", False, True),
        ("a.b", False, False),
        ("a*b", False, False),
        ("^start", False, False),
        ("a.b", True, True),
        ("a\nb", False, False),
        ("a\nb", True, True),
    ],
)
def test_is_literal_pattern(pattern, fixed, expected):
    assert grep_pushdown.is_literal_pattern(pattern, fixed) is expected


def _operand(virtual: str, pattern: str | None = None) -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual.rsplit("/", 1)[0] or "/",
        vfs_path=virtual.strip("/"),
        pattern=pattern,
        resolved=pattern is None,
    )


TRACES = _operand("/traces")
SESSIONS = _operand("/sessions")


def test_lone_operand_is_the_operand_rule_on_its_own():
    # email's find push-down answers for one concrete operand only.
    assert grep_pushdown.lone_operand([TRACES]) is TRACES
    assert grep_pushdown.lone_operand([TRACES, SESSIONS]) is None
    assert grep_pushdown.lone_operand([]) is None
    assert grep_pushdown.lone_operand([_operand("/traces/*", "*")]) is None


def test_lone_operand_never_answers_for_stdin():
    # A `-` is the line's stdin, which no backend holds, so every
    # push-down defers to the scan that reads the pipe.
    dash = PathSpec(
        virtual="/traces/-",
        directory="/traces/",
        vfs_path="traces/-",
        resolved=True,
        raw_path="-",
    )
    assert grep_pushdown.lone_operand([dash]) is None


@pytest.mark.parametrize(
    "pattern, fixed, whole_word, line_regexp, expected",
    [
        ("import", False, True, False, ["import"]),
        ("import", False, False, True, ["import"]),
        ("import", False, False, False, None),
        ("ada\nbob", False, True, False, ["ada", "bob"]),
        ("ada\nada", True, True, False, ["ada"]),
        ("ada\n", False, True, False, None),
        ("ada\nb.b", False, True, False, None),
        ("ada\nb.b", True, True, False, ["ada", "b.b"]),
        (None, False, True, False, None),
    ],
)
def test_whole_word_literals_union_only_complete_alternatives(
    pattern, fixed, whole_word, line_regexp, expected
):
    # A pattern list narrows by one search per alternative, so every
    # alternative must be a whole-word literal; an empty one matches every
    # line, and -x is a whole-line, hence whole-word, match.
    assert (
        grep_pushdown.whole_word_literals(
            pattern, fixed, whole_word, line_regexp
        )
        == expected
    )


@pytest.mark.parametrize(
    "pattern, flags, w, i, expected",
    [
        ("ada\nbob", 0, True, False, (("ada", "bob"), True)),
        ("conn.*refused", 0, False, False, (("refused",), False)),
        ("Conn.*TOMORROW", re.I, False, True, (("tomorrow",), False)),
        ("Conn.*REFUSED", re.I, False, True, None),
        ("a.b", 0, False, False, None),
        ("café", re.I, True, True, None),
        ("ada", re.I, True, True, (("ada",), True)),
        ("sun", re.I, True, True, None),
        ("sun", re.I | re.ASCII, True, True, (("sun",), True)),
    ],
)
def test_search_terms_ask_words_or_the_text_every_match_holds(
    pattern, flags, w, i, expected
):
    # Whole-word literals go as words; any other pattern as the needles
    # every match holds, never shorter than three characters. Under -i a
    # needle or word with s, k or i is dropped when case folds by Unicode
    # (the long s folds to s), and a mount's folding of a non-ASCII
    # literal is not trusted.
    matcher = re.compile(pattern.replace("\n", "|"), flags)
    assert (
        grep_pushdown.search_terms(pattern, matcher, False, w, False, i)
        == expected
    )
