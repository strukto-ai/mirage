import pytest

from mirage.commands.builtin.chroma.find import _default_name, _expr_texts


@pytest.mark.parametrize("texts", [
    ["!", "-name", "x"],
    ["(", "-name", "a", "-o", "-name", "b", ")"],
    ["-name", "x"],
    ["-not", "-name", "x"],
])
def test_expr_texts_preserves_expression(texts):
    assert _expr_texts(texts) == texts


def test_expr_texts_strips_bare_leading_name():
    assert _expr_texts(['foo']) == []
    assert _expr_texts([]) == []


def test_default_name_only_for_bare_word():
    assert _default_name(None, ['foo']) == "foo"
    assert _default_name(None, ['!', '-name', 'x']) is None
    assert _default_name(None, ['(', '-name', 'a']) is None
    assert _default_name('given', ['foo']) == "given"
