import pytest

from mirage.core.awk.errors import AwkSyntaxError
from mirage.core.awk.regex import compile_ere, matches, split_pattern


@pytest.mark.parametrize("pattern,subject,expected", [
    ("[[:digit:]]+", "abc 123", True),
    ("^[[:upper:]]", "hello", False),
    ("[[:space:]]$", "trail ", True),
    ("^[]a]+$", "]a", True),
    ("[^a-c]", "abc", False),
    ("a{2}", "aab", True),
    ("(ab|cd)+$", "abcd", True),
    ("\\.", "a.c", True),
    ("\\.", "abc", False),
    ("a.c", "a\nc", True),
    ("b$", "ab\n", False),
    ("\\<the\\>", "in the end", True),
    ("\\<he\\>", "in the end", False),
    ("\\$", "cost $5", True),
])
def test_matches(pattern, subject, expected):
    assert matches(pattern, subject) is expected


@pytest.mark.parametrize("pattern", ["[", "[[:bogus:]]", "a(b", "*a**"])
def test_bad_patterns_share_one_wording(pattern):
    with pytest.raises(AwkSyntaxError) as raised:
        compile_ere(pattern)
    assert str(raised.value) == ("awk: syntax error in regular expression "
                                 f"{pattern} at source line 1")


def test_split_pattern():
    assert split_pattern(" ") is None
    single = split_pattern("|")
    assert single is not None and single.search("a|b") is not None
    assert single.search("ab") is None
    dot = split_pattern(".")
    assert dot is not None and dot.search("ab") is None
    multi = split_pattern("[,;]+")
    assert multi is not None and multi.search("a,;b") is not None
