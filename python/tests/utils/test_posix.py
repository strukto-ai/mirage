import re

import pytest

from mirage.utils.posix import (
    class_characters,
    compile_posix_regex,
    skip_raw_bytes,
    translate_bracket,
)


def _bracket(pattern: str) -> str:
    out: list[str] = []
    end = translate_bracket(pattern, 0, out)
    assert end == len(pattern)
    return "".join(out)


@pytest.mark.parametrize(
    "name,yes,no",
    [
        ("alnum", "aZ09", "_! "),
        ("alpha", "aZ", "09_"),
        ("blank", " \t", "\nA"),
        ("cntrl", "\x00\x1f\x7f", " A"),
        ("digit", "09", "aF_"),
        ("graph", "!AZ09~", " \t"),
        ("lower", "az", "AZ0"),
        ("print", " AZ09~", "\t\n"),
        ("punct", "![]-_", "aZ0 "),
        ("space", " \t\n\r\f\v", "a0"),
        ("upper", "AZ", "az0"),
        ("xdigit", "09aAfF", "gG_"),
    ],
)
def test_class_membership(name, yes, no):
    compiled = re.compile(_bracket(f"[[:{name}:]]"))
    expanded = class_characters(name) or ""
    for char in yes:
        assert compiled.fullmatch(char)
        assert char in expanded
    for char in no:
        assert not compiled.fullmatch(char)
        assert char not in expanded


def test_class_order_for_translation():
    assert class_characters("space") == "\t\n\v\f\r "
    assert class_characters("lower") == "abcdefghijklmnopqrstuvwxyz"
    assert class_characters("bogus") is None


@pytest.mark.parametrize(
    "pattern", ["[[:bogus:]]", "[[:constructor:]]", "[[:digit:]"]
)
def test_invalid_classes_refused(pattern):
    with pytest.raises(re.error):
        _bracket(pattern)


def test_mixed_brackets():
    compiled = re.compile(_bracket("[][:digit:]_]") + "+")
    assert compiled.fullmatch("]_123")
    assert not compiled.fullmatch("abc")


@pytest.mark.parametrize(
    "source,text,expected",
    [
        ("élan", "ÉLAN", False),
        ("Élan", "ÉLAN", True),
        ("σ", "Σ", False),
        ("k", "K", False),
        ("i", "İ", False),
        ("s", "ſ", False),
        ("[A-Z]+", "MiXeD", True),
        ("[^A-Z]", "a", False),
        ("[^a]", "A", False),
        ("[Z-a]+", "ZA[", True),
        ("[Z-a]", "B", False),
        ("[É]", "é", False),
        ("[^É]", "é", True),
        ("\\D[A-Z]", "!a", True),
        ("\\x41\\u0042", "ab", True),
        ("([A-Z]+)-\\1", "Ab-aB", True),
        ("(É)-\\1", "É-é", False),
        ("(É)-\\1", "É-É", True),
    ],
)
def test_ascii_case_folding(source, text, expected):
    assert (
        bool(compile_posix_regex(source, re.IGNORECASE).fullmatch(text))
        == expected
    )


def test_ascii_captures_preserve_spelling():
    pattern = compile_posix_regex(r"(a)(b)", re.IGNORECASE)
    assert pattern.sub(r"\2\1", "Ab aB") == "bA Ba"


@pytest.mark.parametrize("flags", [0, re.IGNORECASE])
def test_c_locale_whitespace(flags):
    for source in [r"\s", r"[\s]", r"[^\S]"]:
        assert compile_posix_regex(source, flags).search(" ")
        assert not compile_posix_regex(source, flags).search("\u00a0")
    assert compile_posix_regex(r"\S", flags).search("\u00a0")
    assert compile_posix_regex(r"\\s", flags).search(r"\s")


def test_skip_raw_bytes_guards_dots_and_negated_brackets_only():
    guard = "(?![\\udc80-\\udcff])"
    assert skip_raw_bytes(r"a.b\.[.][^x]") == (
        f"a(?:{guard}.)b\\.[.](?:{guard}[^x])"
    )
    assert skip_raw_bytes("[^]x]") == f"(?:{guard}[^]x])"


@pytest.mark.parametrize(
    "source,text,expected",
    [
        ("^a.b$", "aéb", True),
        ("^a.b$", "a\udcffb", False),
        ("^a[^x]b$", "a规b", True),
        ("^a[^x]b$", "a\udcffb", False),
        ("^a\udcffb$", "a\udcffb", True),
        ("^..$", "规定", True),
    ],
)
def test_utf8_subject_matches_characters_not_raw_bytes(source, text, expected):
    pattern = compile_posix_regex(source, 0, True)
    assert bool(pattern.search(text)) == expected


def test_utf8_keeps_dotall_and_ascii_classes():
    assert compile_posix_regex("a.b", re.DOTALL, True).search("a\nb")
    assert not compile_posix_regex("a.b", 0, True).search("a\nb")
    assert not compile_posix_regex(r"\w", 0, True).search("é")
