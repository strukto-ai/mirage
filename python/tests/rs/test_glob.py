import sys
from concurrent.futures import ThreadPoolExecutor

import pytest

from mirage.rs.glob import GlobMatcher, any_tail_matcher, glob_matcher


@pytest.mark.parametrize(
    "pattern,name,expected",
    [
        ("?.txt", "😀.txt", True),
        ("*\udcff", "a" * 30_000 + "\udcff", True),
        ("*b", "a" * 30_000 + "\udcff", False),
        ("\udcff\ud83d", "\udcff\ud83d", True),
    ],
)
def test_a_matcher_counts_characters_and_keeps_lone_surrogates(
    pattern, name, expected
):
    assert GlobMatcher(pattern).matches(name) is expected


@pytest.mark.parametrize(
    "pattern,name,expected",
    [
        ("a.com", "a.co", False),
        ("[a", "[a", True),
        ("\U0000fdd0", "*", True),
        ("\U0000fdd0", "a", False),
    ],
)
def test_a_plain_pattern_matches_its_own_text_alone(pattern, name, expected):
    assert GlobMatcher(pattern).matches(name) is expected


def test_threads_sharing_one_matcher_keep_their_names_apart():
    matcher = glob_matcher("a*z")
    names = [
        ("a" + "x" * 100 * n + ("z" if n % 2 else "y")) for n in range(64)
    ]
    want = [n % 2 == 1 for n in range(64)]

    def scan(_: int) -> bool:
        return all(
            matcher.matches(name) == hit
            for name, hit in zip(names, want, strict=True)
        )

    interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    try:
        with ThreadPoolExecutor(8) as pool:
            assert all(pool.map(scan, range(64)))
    finally:
        sys.setswitchinterval(interval)


@pytest.mark.parametrize(
    "patterns,shown,expected",
    [
        (("b.log",), "b.log", True),
        (("b.log",), "a/b.log", True),
        (("a/b*",), "x/a/b.log", True),
        (("*.log",), "a/b.log", True),
        (("c*",), "a/bc", False),
        (("a",), "a/b", False),
        (("*.txt", "b*"), "a/b.log", True),
        ((), "a/b.log", False),
    ],
)
def test_any_tail_answers_for_the_name_or_a_part_after_a_slash(
    patterns, shown, expected
):
    assert any_tail_matcher(patterns).matches(shown) is expected


def test_any_tail_is_shared_by_callers_asking_the_same():
    assert any_tail_matcher(("a", "b")) is any_tail_matcher(("a", "b"))
    assert any_tail_matcher(("a", "b")) is not any_tail_matcher(("b", "a"))
