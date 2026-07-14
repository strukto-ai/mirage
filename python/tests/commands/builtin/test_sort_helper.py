from mirage.commands.builtin.sort_helper import _sort_key


def test_key_field_with_explicit_sep_keeps_leading_blanks():
    key = _sort_key("x: b", 2, ":", False, False)
    assert key == " b"


def test_strip_blanks_ignores_key_leading_blanks():
    key = _sort_key("x: b", 2, ":", False, False, strip_blanks=True)
    assert key == "b"


def test_strip_blanks_without_key_field_is_noop():
    assert _sort_key("  both  ", None, None, False, False,
                     strip_blanks=True) == "  both  "
