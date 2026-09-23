import pytest

from mirage.core.awk.errors import AwkSyntaxError
from mirage.core.awk.lexer import TokKind, tokenize


def kinds(src: str) -> list[tuple[TokKind, str]]:
    return [(t.kind, t.text) for t in tokenize(src)[:-1]]


def test_slash_divides_after_an_operand_and_opens_a_regex_elsewhere():
    assert kinds("a / b") == [(TokKind.NAME, "a"), (TokKind.OP, "/"),
                              (TokKind.NAME, "b")]
    assert kinds("$0 ~ /a\\/b/") == [(TokKind.OP, "$"), (TokKind.NUMBER, "0"),
                                     (TokKind.OP, "~"), (TokKind.ERE, "a/b")]


def test_a_name_glued_to_a_paren_is_a_call():
    assert kinds("f(1)")[0] == (TokKind.FUNC_NAME, "f")
    assert kinds("f (1)")[0] == (TokKind.NAME, "f")


def test_string_escapes_and_octal():
    assert tokenize('"a\\tb\\101\\""')[0].value == 'a\tbA"'


def test_power_spellings_fold_to_caret():
    assert kinds("a ** b **= c") == [(TokKind.NAME, "a"), (TokKind.OP, "^"),
                                     (TokKind.NAME, "b"), (TokKind.OP, "^="),
                                     (TokKind.NAME, "c")]


def test_numbers_take_a_fraction_and_an_exponent():
    assert [t.text for t in tokenize("1 .5 1e3 2.5E-2 1e")[:-1]
            ] == ["1", ".5", "1e3", "2.5E-2", "1", "e"]


def test_comment_and_continuation_are_skipped():
    assert kinds("a # note\n\\\nb") == [(TokKind.NAME, "a"),
                                        (TokKind.NEWLINE, "\n"),
                                        (TokKind.NAME, "b")]


def test_a_non_ascii_letter_is_not_a_name():
    with pytest.raises(AwkSyntaxError, match="unexpected character"):
        tokenize("é = 1")


@pytest.mark.parametrize("src", ['"open', "/open", '"a\nb"'])
def test_unterminated_literals_are_syntax_errors(src):
    with pytest.raises(AwkSyntaxError):
        tokenize(src)
