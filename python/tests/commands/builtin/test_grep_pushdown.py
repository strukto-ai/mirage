import re

import pytest

from mirage.commands.builtin import grep_pushdown
from mirage.commands.builtin.constants import PatternType
from mirage.types import PathSpec


def test_classify_pattern_newline_list_is_regex():
    assert grep_pushdown.classify_pattern("foo\nbar",
                                          False) == PatternType.REGEX
    assert grep_pushdown.classify_pattern("foo\nbar",
                                          True) == PatternType.REGEX
    assert grep_pushdown.classify_pattern("foo bar",
                                          False) == PatternType.SIMPLE


@pytest.mark.parametrize("pattern,expected", [
    ("import.*os", "import"),
    ("imp.*rt", "imp"),
    ("^import", "import"),
    ("colou?r", "colo"),
    ("[Ee]rror", "rror"),
    (r"\d+error", "error"),
    ("config$", "config"),
    ("a*b", None),
    ("ab", None),
    ("foo|bar", None),
    ("(ab)?cdef", "cdef"),
    ("(foo)?bar", "bar"),
    ("x(foo)*y", None),
    ("foo(bar)?baz", "foo"),
    ("(foo){0,2}bar", "bar"),
    ("(foo){1,2}bar", "foo"),
    ("(foo)+bar", "foo"),
    ("a(b(cdef)?g)?h", None),
    ("(?:foo)?bar", None),
])
def test_extract_required_literal(pattern, expected):
    assert grep_pushdown.extract_required_literal(pattern) == expected


def test_extract_literal_is_required_substring():
    for pattern in ("import.*os", "colou?r", "[Ee]rror", r"\d+error",
                    "(foo)?bar", "foo(bar)?baz"):
        literal = grep_pushdown.extract_required_literal(pattern)
        assert literal is not None
        for sample in ("import sys, os", "color", "colour", "Error here",
                       "an error", "x42error", "bar", "foobar", "foobaz"):
            if re.search(pattern, sample):
                assert literal in sample


def test_search_query_literal_returns_pattern():
    assert grep_pushdown.search_query("import", False) == "import"
    assert grep_pushdown.search_query("foo", True) == "foo"


def test_search_query_regex_extracts_literal():
    assert grep_pushdown.search_query("import.*os", False) == "import"


def test_search_query_regex_no_literal_is_none():
    assert grep_pushdown.search_query("foo|bar", False) is None


def test_search_query_reads_a_dot_as_the_regex_it_is():
    # `worker.3` matches `worker-3`, which a substring search for
    # `worker.3` never returns; only the run before the dot is required.
    assert grep_pushdown.search_query("worker.3", False) == "worker"
    assert grep_pushdown.search_query("worker.3", True) == "worker.3"


def test_search_query_reads_a_basic_expression_in_its_own_dialect():
    # grep reads a basic expression unless -E says otherwise, where the
    # operators are the escaped spellings and bare parens are literal.
    assert grep_pushdown.search_query(r"fo\(bar\)\?baz", False,
                                      basic=True) == "baz"
    assert grep_pushdown.search_query("(foo)?bar", False, basic=True) == "foo"
    assert grep_pushdown.search_query("(foo)?bar", False) == "bar"


def test_search_query_never_answers_for_a_pattern_list():
    # A newline-joined -e list is a set of alternatives; no one literal
    # is required by all of them.
    assert grep_pushdown.search_query("foo\nbar", True) is None
    assert grep_pushdown.search_query("foo\nbar", False) is None


@pytest.mark.parametrize("pattern,fixed,expected", [
    ("abc", False, True),
    ("a-b_c.d", False, False),
    ("plain text", False, True),
    ("a.b", False, False),
    ("a*b", False, False),
    ("^start", False, False),
    ("a.b", True, True),
    ("a\nb", False, False),
    ("a\nb", True, True),
])
def test_is_literal_pattern(pattern, fixed, expected):
    assert grep_pushdown.is_literal_pattern(pattern, fixed) is expected


@pytest.mark.parametrize("flags,expected", [
    ({}, False),
    ({
        "i": True
    }, False),
    ({
        "F": True
    }, False),
    ({
        "r": True
    }, False),
    ({
        "v": True
    }, True),
    ({
        "n": True
    }, True),
    ({
        "c": True
    }, True),
    ({
        "args_l": True
    }, True),
    ({
        "w": True
    }, True),
    ({
        "o": True
    }, True),
    ({
        "q": True
    }, True),
    ({
        "H": True
    }, True),
    ({
        "h": True
    }, True),
    ({
        "m": "3"
    }, True),
    ({
        "A": "2"
    }, True),
    ({
        "B": "2"
    }, True),
    ({
        "C": "2"
    }, True),
])
def test_has_search_shaping_flags(flags, expected):
    assert grep_pushdown.has_search_shaping_flags(flags) is expected


def test_has_search_shaping_flags_reads_a_count_dest_as_a_number():
    """A count dest arrives as a number as readily as a numeric string.

    ``fl.as_int`` sees both. TypeScript tested ``typeof flags[name] ===
    'string'`` and so missed the number, which let an unsafe push-down
    through on one host only (issue #1089 item 11a).
    """
    assert grep_pushdown.has_search_shaping_flags({"m": "3"}) is True
    assert grep_pushdown.has_search_shaping_flags({"m": 3}) is True
    assert grep_pushdown.has_search_shaping_flags({"A": 2}) is True
    assert grep_pushdown.has_search_shaping_flags({"B": 2}) is True
    assert grep_pushdown.has_search_shaping_flags({"C": 2}) is True


def test_has_search_shaping_flags_splits_list_and_str_filters():
    """The repeatable filters read as lists, the single-valued ones as str.

    An empty list and a bare boolean both mean "not supplied"; the flat
    ``flags[name] is not None`` shape TypeScript had called each of them
    supplied and deferred.
    """
    assert grep_pushdown.has_search_shaping_flags({"include":
                                                   ["*.py"]}) is True
    assert grep_pushdown.has_search_shaping_flags({"exclude":
                                                   ["*.log"]}) is True
    assert grep_pushdown.has_search_shaping_flags(
        {"exclude_dir": ["node_modules"]}) is True
    assert grep_pushdown.has_search_shaping_flags({"include": []}) is False
    assert grep_pushdown.has_search_shaping_flags({"type": "py"}) is True
    assert grep_pushdown.has_search_shaping_flags({"glob": "*.py"}) is True
    assert grep_pushdown.has_search_shaping_flags({"glob": True}) is False


def test_search_pushdown_ok_plain_literal():
    assert grep_pushdown.search_pushdown_ok({}, "ada") is True
    assert grep_pushdown.search_pushdown_ok({"i": True}, "ada") is True


def test_search_pushdown_ok_rejects_shaping_flag():
    assert grep_pushdown.search_pushdown_ok({"v": True}, "ada") is False
    assert grep_pushdown.search_pushdown_ok({"c": True}, "ada") is False


def test_search_pushdown_ok_rejects_regex_but_allows_fixed_string():
    assert grep_pushdown.search_pushdown_ok({}, "a.b") is False
    assert grep_pushdown.search_pushdown_ok({"F": True}, "a.b") is True


def _operand(virtual: str, pattern: str | None = None) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0] or "/",
                    resource_path=virtual.strip("/"),
                    pattern=pattern,
                    resolved=pattern is None)


TRACES = _operand("/traces")
SESSIONS = _operand("/sessions")


def test_pushdown_operand_admits_one_concrete_operand():
    assert grep_pushdown.pushdown_operand([TRACES], {}, "ada") is TRACES


def test_pushdown_operand_refuses_a_second_operand():
    # The bug this gate exists for: the push-down answered for the first
    # operand and dropped the rest in silence.
    assert grep_pushdown.pushdown_operand([TRACES, SESSIONS], {},
                                          "ada") is None
    # Two operands in one family, which a per-operand push-down would have
    # answered twice over.
    assert grep_pushdown.pushdown_operand([TRACES, TRACES], {}, "ada") is None


def test_pushdown_operand_refuses_no_operand():
    assert grep_pushdown.pushdown_operand([], {}, "ada") is None


def test_pushdown_operand_refuses_glob_shaping_and_pattern_list():
    assert grep_pushdown.pushdown_operand([_operand("/traces/*", "*")], {},
                                          "ada") is None
    assert grep_pushdown.pushdown_operand([TRACES], {"c": True}, "ada") is None
    assert grep_pushdown.pushdown_operand([TRACES], {}, "ada\nbob") is None
    assert grep_pushdown.pushdown_operand([TRACES], {}, None) is None


def test_literal_pushdown_operand_adds_the_like_pattern_rule():
    assert grep_pushdown.literal_pushdown_operand([TRACES], {},
                                                  "ada") is TRACES
    # Everything pushdown_operand refuses, this refuses too.
    assert grep_pushdown.literal_pushdown_operand([TRACES, SESSIONS], {},
                                                  "ada") is None
    assert grep_pushdown.literal_pushdown_operand([TRACES], {"c": True},
                                                  "ada") is None
    # Plus the one it adds: LIKE matches a regex literally.
    assert grep_pushdown.literal_pushdown_operand([TRACES], {}, "a.b") is None
    assert grep_pushdown.literal_pushdown_operand([TRACES], {"F": True},
                                                  "a.b") is TRACES


EMAIL_HONORED = ("n", "args_l", "w", "o", "m")


def test_has_search_shaping_flags_exempts_only_the_named_dests():
    # gmail/slack/discord: the provider's search is word-based, so -w is what
    # makes the push-down faithful rather than what breaks it.
    assert not grep_pushdown.has_search_shaping_flags({"w": True}, ("w", ))
    assert grep_pushdown.has_search_shaping_flags({
        "w": True,
        "n": True
    }, ("w", ))
    # email: the local re-scan implements these, so they ride along.
    assert not grep_pushdown.has_search_shaping_flags(
        {
            "n": True,
            "o": True,
            "m": "3"
        }, EMAIL_HONORED)
    # ...but never -v or -c, which need messages the search did not return.
    assert grep_pushdown.has_search_shaping_flags({"v": True}, EMAIL_HONORED)
    assert grep_pushdown.has_search_shaping_flags({"c": True}, EMAIL_HONORED)


def test_honored_never_exempts_the_operand_rule():
    # An exemption is about flags only: two operands still defer.
    assert grep_pushdown.pushdown_operand([TRACES, SESSIONS], {"w": True},
                                          "ada", ("w", )) is None
    assert grep_pushdown.pushdown_operand([TRACES], {"w": True}, "ada",
                                          ("w", )) is TRACES


def test_lone_operand_is_the_operand_rule_on_its_own():
    # email's find push-down has no grep pattern and no shaping flags.
    assert grep_pushdown.lone_operand([TRACES]) is TRACES
    assert grep_pushdown.lone_operand([TRACES, SESSIONS]) is None
    assert grep_pushdown.lone_operand([]) is None
    assert grep_pushdown.lone_operand([_operand("/traces/*", "*")]) is None


@pytest.mark.parametrize("mode", ["binary", "text", "without-match", "bad"])
def test_binary_mode_requires_scanning(mode):
    assert grep_pushdown.has_search_shaping_flags({"binary_files": mode})


@pytest.mark.parametrize("text,expected", [("hello 😀", True),
                                           ("hello\0tail", False),
                                           ("hello\udcff", False)])
def test_search_result_binary_guard(text, expected):
    assert grep_pushdown.text_search_results([text]) is expected
