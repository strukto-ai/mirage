import re

import pytest

from mirage.concurrency.constants import LOOP_BUDGET
from mirage.utils.regex_cost import loop_limit


@pytest.mark.parametrize(
    "pattern",
    [
        r"(a+)+$",
        r"(?:a*)*b",
        r"(?:a|b)+",
        r"(a)\1",
        r"(?P<x>a)(?P=x)",
        r"(?=.*x)",
        r"(a)?(?(1)b|c)",
        r"(?x) a b",
        r"(?x: a)",
    ],
)
def test_a_shape_that_can_backtrack_without_bound_never_runs_in_place(
    pattern,
):
    assert loop_limit(re.compile(pattern)) == -1


def test_a_verbose_pattern_never_runs_in_place():
    assert loop_limit(re.compile("a", re.VERBOSE)) == -1


@pytest.mark.parametrize(
    "pattern,shorter,longer",
    [
        ("needle", r"[0-9]*", r"\bdef \w+\("),
        ("TODO|FIXME", "x.*y", "a*a*b"),
        (r"(?<![0-9A-Z_a-z])(?:a)(?![0-9A-Z_a-z])", "(?:ab)+", "a*a*b"),
    ],
)
def test_more_branching_runs_shorter_subjects_in_place(
    pattern, shorter, longer
):
    limits = [loop_limit(re.compile(p)) for p in (pattern, shorter, longer)]
    assert limits[0] > limits[1] > limits[2] > 0


def test_an_anchored_literal_runs_any_line_in_place():
    assert loop_limit(re.compile(r"^unique_history_1221\Z")) > 900_000
    assert loop_limit(re.compile("^a|b")) < loop_limit(re.compile("^ab"))
    assert loop_limit(re.compile("^ab", re.MULTILINE)) < loop_limit(
        re.compile("^ab")
    )


def test_a_literal_brace_is_one_character():
    assert loop_limit(re.compile("a{x}")) == loop_limit(re.compile("a[{]x}"))


def test_no_limit_exceeds_the_budget():
    assert loop_limit(re.compile("")) <= LOOP_BUDGET


def test_a_repeat_counts_the_work_inside_each_count():
    assert loop_limit(re.compile(r"^(?:(?=a{60000})a)*b")) < 10
    assert loop_limit(re.compile("(?:(?=a{9})a)*b")) < loop_limit(
        re.compile("(?:a)*b")
    )


def test_groups_nested_past_the_depth_go_to_the_worker():
    assert loop_limit(re.compile("(" * 100 + "a" + ")" * 100)) == -1
    assert loop_limit(re.compile("(" * 10 + "a" + ")" * 10)) > 0
