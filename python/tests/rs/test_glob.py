import sys
from concurrent.futures import ThreadPoolExecutor

import pytest

from mirage.rs.glob import GlobMatcher, glob_matcher


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
