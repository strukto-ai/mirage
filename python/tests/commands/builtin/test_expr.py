# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import asyncio

import pytest

from mirage.commands.builtin.general.expr import (DIGIT_CHUNK, ExprError,
                                                  _expr_eval, digits_of_int,
                                                  from_byte_view,
                                                  int_of_digits, is_null,
                                                  to_byte_view)
from mirage.commands.builtin.utils.bre import translate_bre
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _ws():
    mem = RAMVFS()
    ws = Workspace(
        {"/data": (mem, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    return ws, mem


def _run_raw(ws, cmd, cwd="/", stdin=None):
    ws._cwd = cwd
    io = asyncio.run(ws.shell(cmd, stdin=stdin))
    return io.stdout, io


def _bytes(stdout):
    if isinstance(stdout, bytes):
        return stdout
    return b"".join(asyncio.run(_collect(stdout)))


async def _collect(ait):
    return [chunk async for chunk in ait]


def test_expr_add():
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "expr 3 + 4")
    assert _bytes(stdout).strip() == b"7"
    assert io.exit_code == 0


def test_expr_compare():
    ws, _ = _ws()
    stdout, io = _run_raw(ws, "expr 5 '>' 3")
    assert _bytes(stdout).strip() == b"1"
    assert io.exit_code == 0


def _stderr_text(io):
    err = io.stderr
    if err is None:
        return ""
    return err.decode() if isinstance(err, bytes) else str(err)


def _out(cmd):
    ws, _ = _ws()
    stdout, io = _run_raw(ws, cmd)
    return (b"" if stdout is None else _bytes(stdout)), io


def test_expr_division_truncates_toward_zero():
    # GNU truncates, python's `//` floors: `-10 / 3` is -3, not -4.
    assert _expr_eval(["-10", "/", "3"]) == ("-3", 0)
    assert _expr_eval(["10", "/", "-3"]) == ("-3", 0)
    assert _expr_eval(["-10", "/", "-3"]) == ("3", 0)
    assert _expr_eval(["-7", "/", "2"]) == ("-3", 0)


def test_expr_remainder_takes_the_dividend_sign():
    # GNU: `-10 % 3` is -1 where python answers 2, and `10 % -3` is 1
    # where python answers -2.
    assert _expr_eval(["-10", "%", "3"]) == ("-1", 0)
    assert _expr_eval(["10", "%", "-3"]) == ("1", 0)
    assert _expr_eval(["-7", "%", "2"]) == ("-1", 0)


def test_expr_exits_one_when_the_result_is_zero():
    # POSIX: exit 1 means "succeeded, the value was 0 or empty". Only
    # exit 2 is an error, so the two must not be conflated.
    assert _expr_eval(["-1", "/", "2"]) == ("0", 1)
    assert _expr_eval(["1", "/", "-2"]) == ("0", 1)


def test_expr_is_arbitrary_precision():
    assert _expr_eval(["9223372036854775807", "+",
                       "1"]) == ("9223372036854775808", 0)
    assert _expr_eval(["2", "*",
                       "99999999999999999999"]) == ("199999999999999999998", 0)


# An operand past every float's range, which is where a float64 host
# stopped reading the word as a number at all and started comparing the
# two sides as strings. The mirrored rows are in expr.test.ts.
BEYOND_FLOAT = "1" + "0" * 320


def test_expr_compares_an_operand_past_every_float_as_a_number():
    # The decisive rows: a float64 read answered these upside down,
    # because `Infinity` is not an integer operand and the comparison
    # quietly became a byte-order string compare.
    assert _expr_eval(["2", "<", BEYOND_FLOAT]) == ("1", 0)
    assert _expr_eval(["2", ">", BEYOND_FLOAT]) == ("0", 1)
    assert _expr_eval([BEYOND_FLOAT, ">", "2"]) == ("1", 0)
    assert _expr_eval(["-" + BEYOND_FLOAT, "<", "2"]) == ("1", 0)


def test_expr_arithmetic_on_an_operand_past_every_float():
    assert _expr_eval([BEYOND_FLOAT, "+", "0"]) == (BEYOND_FLOAT, 0)
    assert _expr_eval([BEYOND_FLOAT, "%", "7"]) == ("2", 0)


def test_expr_never_prints_exponential_notation():
    # `expr` cannot print `1e+24`, and could not read it back as an
    # operand either, so a product this size has to render in full.
    assert _expr_eval(["1000000000000", "*",
                       "1000000000000"]) == ("1" + "0" * 24, 0)
    assert _expr_eval(["999999999999999999999", "+",
                       "1"]) == ("1" + "0" * 21, 0)
    assert _expr_eval(["2147483647", "*",
                       "2147483647"]) == ("4611686014132420609", 0)


def test_expr_substr_clamps_a_length_past_every_float():
    assert _expr_eval(["substr", "abcde", "1", BEYOND_FLOAT]) == ("abcde", 0)
    assert _expr_eval(["substr", "abcde", BEYOND_FLOAT, "1"]) == ("", 1)


def test_expr_refuses_an_operand_with_a_trailing_newline():
    # python's `$` also matches immediately before a trailing newline, so
    # `^-?[0-9]+$` with `match` read `12\n` as 12. GNU's scanner stops at
    # the first non-digit and refuses the word.
    with pytest.raises(ExprError) as caught:
        _expr_eval(["12\n", "+", "1"])
    assert str(caught.value) == "expr: non-integer argument"
    # The same word in a comparison is a string, not a number, so
    # `12\n` and `12` are not equal.
    assert _expr_eval(["12\n", "=", "12"]) == ("0", 1)
    assert _expr_eval(["substr", "abcde", "2\n", "1"]) == ("", 1)


def test_expr_accepts_leading_zeros_as_decimal():
    # `05` is decimal 5, not octal, and `00` / `-0` are zero.
    assert _expr_eval(["05", "+", "1"]) == ("6", 0)
    assert _expr_eval(["00", "+", "1"]) == ("1", 0)
    assert _expr_eval(["-0", "+", "1"]) == ("1", 0)


def test_expr_rejects_operands_python_int_would_accept():
    # GNU's operand grammar is narrower than `int()`: no explicit plus,
    # no surrounding whitespace, no digit separator, no hex, no float.
    for operand in ("+5", " 5 ", " 5", "5 ", "1_0", "0x10", "1e3", "abc",
                    "1.5"):
        with pytest.raises(ExprError) as caught:
            _expr_eval([operand, "+", "1"])
        assert str(caught.value) == "expr: non-integer argument"


def test_expr_comparison_falls_back_to_strings_for_a_bad_operand():
    # `+5` is not an integer operand, so GNU compares the two as
    # strings and `+5` != `5`.
    assert _expr_eval(["+5", "=", "5"]) == ("0", 1)


def test_expr_zero_divisor_raises_gnu_wording():
    for op in ("/", "%"):
        with pytest.raises(ExprError) as caught:
            _expr_eval(["1", op, "0"])
        assert str(caught.value) == "expr: division by zero"


def test_expr_division_by_zero_exits_two_with_empty_stdout():
    # GNU: nothing on stdout, one lower-case line on stderr with no
    # trailing period, exit 2.
    stdout, io = _out("expr 1 '/' 0")
    assert stdout == b""
    assert _stderr_text(io) == "expr: division by zero\n"
    assert io.exit_code == 2


def test_expr_modulo_by_zero_uses_the_same_message():
    stdout, io = _out("expr 1 '%' 0")
    assert stdout == b""
    assert _stderr_text(io) == "expr: division by zero\n"
    assert io.exit_code == 2


def test_expr_non_integer_operand_exits_two_with_empty_stdout():
    stdout, io = _out("expr '+5' + 1")
    assert stdout == b""
    assert _stderr_text(io) == "expr: non-integer argument\n"
    assert io.exit_code == 2


# Every row below is a measured GNU coreutils 9.4 answer under `LC_ALL=C`.
PRECEDENCE = [
    # `* / %` bind tighter than `+ -`.
    (["2", "+", "3", "*", "4"], "14", 0),
    (["2", "*", "3", "+", "4"], "10", 0),
    (["2", "+", "10", "%", "4"], "4", 0),
    # Every level is left-associative.
    (["10", "-", "2", "-", "3"], "5", 0),
    (["100", "/", "10", "/", "2"], "5", 0),
    (["2", "*", "3", "*", "4"], "24", 0),
    (["10", "%", "4", "*", "2"], "4", 0),
    (["2", "*", "10", "%", "4"], "0", 1),
    (["1", "<", "2", "=", "1"], "1", 0),
    (["10", "<", "9", "<", "8"], "1", 0),
    # `+ -` bind tighter than the comparisons, which bind tighter than
    # `&`, which binds tighter than `|`.
    (["1", "+", "2", "=", "3"], "1", 0),
    (["1", "&", "1", "=", "2"], "0", 1),
    (["1", "|", "0", "=", "0"], "1", 0),
    (["2", "|", "0", "&", "0"], "2", 0),
    # `:` is tighter than any arithmetic, and left-associative.
    (["1", "+", "abc", ":", "a"], "2", 0),
    (["abc", ":", "a", "+", "1"], "2", 0),
    (["abc", ":", "a", ":", "1"], "1", 0),
    # There is no unary operator: `-5` is an integer literal.
    (["-5", "+", "3"], "-2", 0),
    (["3", "-", "-5"], "8", 0),
]


@pytest.mark.parametrize("args,value,code", PRECEDENCE)
def test_expr_precedence_table(args, value, code):
    assert _expr_eval(list(args)) == (value, code)


def test_expr_does_not_know_caret_angle_or_bang():
    # None of these is an operator, so each leaves a word with no slot.
    for args, detail in (
        (["2", "^", "3"], "unexpected argument '^'"),
        (["1", "<>", "2"], "unexpected argument '<>'"),
        (["!", "0"], "unexpected argument '0'"),
    ):
        with pytest.raises(ExprError) as caught:
            _expr_eval(list(args))
        assert str(caught.value) == f"expr: syntax error: {detail}"


SHORT_CIRCUIT = [
    (["0", "|", "3"], "3", 0),
    (["", "|", "7"], "7", 0),
    (["2", "&", "3"], "2", 0),
    (["0", "&", "3"], "0", 1),
    # The right operand is never evaluated once the left decides, so
    # neither of these reports a division by zero.
    (["1", "|", "1", "/", "0"], "1", 0),
    (["0", "&", "1", "/", "0"], "0", 1),
]


@pytest.mark.parametrize("args,value,code", SHORT_CIRCUIT)
def test_expr_or_and_and_short_circuit(args, value, code):
    assert _expr_eval(list(args)) == (value, code)


def test_expr_truthiness_counts_any_run_of_zeros_as_false():
    # GNU's `null()` is not "empty or the character zero": `00` and
    # `-000` are false too, while a bare `-` is true.
    assert [is_null(v) for v in ("", "0", "00", "-0", "-000")] == [True] * 5
    assert [is_null(v) for v in ("-", "1", "0a", "00 ")] == [False] * 4


PARENS = [
    (["(", "2", "+", "3", ")", "*", "4"], "20", 0),
    (["(", "(", "1", "+", "2", ")", ")"], "3", 0),
    (["(", "abc", ")", ":", "a"], "1", 0),
    (["length", "(", "abc", ")"], "3", 0),
    (["(", "length", "abcde", ")", "*", "2"], "10", 0),
    (["(", "+", "1", ")", "+", "2"], "3", 0),
]


@pytest.mark.parametrize("args,value,code", PARENS)
def test_expr_parentheses(args, value, code):
    assert _expr_eval(list(args)) == (value, code)


def test_expr_refuses_nesting_past_our_own_limit():
    # GNU declares no limit and segfaults with nothing on stderr, so the
    # limit and its wording are ours, not a GNU string.
    assert _expr_eval(["("] * 64 + ["1"] + [")"] * 64) == ("1", 0)
    with pytest.raises(ExprError) as caught:
        _expr_eval(["("] * 65 + ["1"] + [")"] * 65)
    assert str(caught.value) == ("expr: expression nesting too deep "
                                 "(limit 64)")


QUOTING = [
    (["+", "hello"], "hello", 0),
    (["+", "+"], "+", 0),
    (["+", "1"], "1", 0),
    (["+", "length"], "length", 0),
    (["+", "match"], "match", 0),
    (["+", "("], "(", 0),
    (["+", ")"], ")", 0),
    (["+", ""], "", 1),
    (["+", "0"], "0", 1),
    # `+ TOKEN` is a primary, so it composes with the rest of the
    # grammar and its result is re-read as a number when one is needed.
    (["1", "+", "+", "2"], "3", 0),
    (["+", "2", "*", "3"], "6", 0),
    (["2", "*", "+", "3"], "6", 0),
    (["+", "abc", ":", "a"], "1", 0),
    (["abc", ":", "+", "a"], "1", 0),
    (["length", "+", "length"], "6", 0),
]


@pytest.mark.parametrize("args,value,code", QUOTING)
def test_expr_plus_quotes_exactly_one_word(args, value, code):
    assert _expr_eval(list(args)) == (value, code)


def test_expr_plus_does_not_recurse():
    # The quoted token eats the second operator, so the next word has no
    # slot left.
    for args, detail in (
        (["+"], "missing argument after '+'"),
        (["+", "+", "hello"], "unexpected argument 'hello'"),
        (["+", "length", "abcde"], "unexpected argument 'abcde'"),
    ):
        with pytest.raises(ExprError) as caught:
            _expr_eval(list(args))
        assert str(caught.value) == f"expr: syntax error: {detail}"


KEYWORDS = [
    (["length", "abcde"], "5", 0),
    (["length", ""], "0", 1),
    # `substr` is 1-based, clamps an over-long length, and answers the
    # empty string -- not an error -- for every out-of-range position.
    (["substr", "abcde", "2", "3"], "bcd", 0),
    (["substr", "abcde", "2", "99"], "bcde", 0),
    (["substr", "abcde", "0", "3"], "", 1),
    (["substr", "abcde", "9", "1"], "", 1),
    (["substr", "abcde", "1", "0"], "", 1),
    (["substr", "abcde", "-1", "3"], "", 1),
    (["substr", "abcde", "2", "-1"], "", 1),
    (["substr", "abc", "x", "1"], "", 1),
    # `index` is `strcspn` over a character set, not a substring search:
    # `c` at 3 beats `e` at 5.
    (["index", "abcde", "cd"], "3", 0),
    (["index", "abcde", "ec"], "3", 0),
    (["index", "abcde", "xyz"], "0", 1),
    (["index", "abcde", ""], "0", 1),
    # `match` is the prefix spelling of `:`.
    (["match", "abcdef", "abc"], "3", 0),
    (["match", "abcdef", r"a\(bc\)"], "bc", 0),
    (["abcdef", ":", "abc"], "3", 0),
    (["abcdef", ":", r"a\(bc\)"], "bc", 0),
    # A failed match answers `0`, or the empty string when the pattern
    # has a group at all -- including one that did not participate.
    (["abc", ":", "x"], "0", 1),
    (["abc", ":", r"\(x\)"], "", 1),
    (["abc", ":", r"a\(x\)\?"], "", 1),
]


@pytest.mark.parametrize("args,value,code", KEYWORDS)
def test_expr_keyword_operators(args, value, code):
    assert _expr_eval(list(args)) == (value, code)


def test_expr_keyword_missing_operand_names_the_last_word_seen():
    for args, detail in (
        (["length"], "missing argument after 'length'"),
        (["substr", "abc", "1"], "missing argument after '1'"),
        (["index", "abc"], "missing argument after 'abc'"),
        (["match", "abc"], "missing argument after 'abc'"),
        (["substr", "abc", "1", "2", "3"], "unexpected argument '3'"),
    ):
        with pytest.raises(ExprError) as caught:
            _expr_eval(list(args))
        assert str(caught.value) == f"expr: syntax error: {detail}"


BRE = [
    # Implicitly anchored at the start of the subject.
    (["abc", ":", "b"], "0", 1),
    (["abc", ":", "a.c"], "3", 0),
    (["abc", ":", ".*"], "3", 0),
    (["abc", ":", "^abc$"], "3", 0),
    # `\+` and `\?` quantify; bare `+` and `?` are literals.
    (["abc", ":", r"a\+"], "1", 0),
    (["aaa", ":", r"a\+"], "3", 0),
    (["a+b", ":", "a+b"], "3", 0),
    (["abc", ":", r"a\?"], "1", 0),
    (["a?", ":", "a?"], "2", 0),
    # `\|` alternates; bare `|` is a literal.
    (["abc", ":", r"a\|b"], "1", 0),
    (["abc", ":", "a|b"], "0", 1),
    (["a|b", ":", "a|b"], "3", 0),
    # `\(` `\)` are the groups, and only group 1 is returned.
    (["abc", ":", r"\(a\)\(b\)"], "a", 0),
    # `\{n\}` is the interval; bare `{n}` is a literal.
    (["aab", ":", r"a\{2\}"], "2", 0),
    (["abc", ":", r"a\{2\}"], "0", 1),
    (["aab", ":", "a{2}"], "0", 1),
    (["a{2}", ":", "a{2}"], "4", 0),
    # A leading `*` is a literal, where both host engines throw.
    (["*a", ":", "*a"], "2", 0),
    (["abc", ":", "*a"], "0", 1),
    # A mid-pattern `^` or `$` is a literal.
    (["abc", ":", "a^b"], "0", 1),
    (["a^b", ":", "a^b"], "3", 0),
    (["a$b", ":", "a$b"], "3", 0),
    # POSIX classes, GNU `\w`, and backreferences.
    (["abc", ":", r"[[:alpha:]]\+"], "3", 0),
    (["abc", ":", r"\w\+"], "3", 0),
    (["aab", ":", r"\(a\)\1"], "a", 0),
    (["abc", ":", r"\(a\)\1"], "", 1),
]


@pytest.mark.parametrize("args,value,code", BRE)
def test_expr_colon_is_a_posix_bre(args, value, code):
    assert _expr_eval(list(args)) == (value, code)


def test_expr_bad_regex_uses_glibc_regerror_wording():
    # These three strings are glibc's, printed verbatim under expr's own
    # prefix, which is why they read the way they do.
    for pattern, message in (
        (r"\(", "expr: Unmatched ( or \\("),
        ("[", "expr: Invalid regular expression"),
        (r"a\{1,", "expr: Unmatched \\{"),
    ):
        with pytest.raises(ExprError) as caught:
            _expr_eval(["abc", ":", pattern])
        assert str(caught.value) == message


TRANSLATIONS = [
    (r"a\(bc\)", "a(bc)", 1),
    ("a(bc)", r"a\(bc\)", 0),
    (r"a\|b", "a|b", 0),
    ("a|b", r"a\|b", 0),
    (r"a\+", "a+", 0),
    ("a+", r"a\+", 0),
    (r"a\{2,3\}", "a{2,3}", 0),
    ("a{2}", r"a\{2\}", 0),
    ("*a", r"\*a", 0),
    ("[[:alpha:]]", "[A-Za-z]", 0),
    (r"\w", "[0-9A-Za-z_]", 0),
]


@pytest.mark.parametrize("pattern,source,groups", TRANSLATIONS)
def test_expr_bre_translation_inverts_the_escaping(pattern, source, groups):
    assert translate_bre(pattern) == (source, groups)


COMPARISONS = [
    # Numeric only when both sides are integers in GNU's grammar.
    (["10", ">", "9"], "1", 0),
    (["9", "<", "10"], "1", 0),
    (["010", "=", "10"], "1", 0),
    (["-0", "=", "0"], "1", 0),
    # Otherwise a byte-order string compare, never a refusal.
    (["abc", ">", "abd"], "0", 1),
    (["10", ">", "9a"], "0", 1),
    (["9a", "<", "10"], "0", 1),
    ([" 10", "=", "10"], "0", 1),
    (["+1", "=", "1"], "0", 1),
    (["", "=", ""], "1", 0),
    (["1", "<", ""], "0", 1),
    (["", "<", "1"], "1", 0),
    (["abc", "<", "ABC"], "0", 1),
    # `==` is an undocumented synonym for `=`.
    (["1", "==", "1"], "1", 0),
    (["1", "==", "2"], "0", 1),
    (["abc", "==", "abc"], "1", 0),
    (["1", "!=", "2"], "1", 0),
    (["1", "<=", "1"], "1", 0),
    (["1", ">=", "2"], "0", 1),
]


@pytest.mark.parametrize("args,value,code", COMPARISONS)
def test_expr_comparison_is_numeric_only_when_both_sides_are(
        args, value, code):
    assert _expr_eval(list(args)) == (value, code)


def test_expr_zero_expression_words_is_the_only_two_line_diagnostic():
    # `expr` and `expr --` both leave zero expression words, and this is
    # the one refusal that carries the `--help` hint.
    for line in ("expr", "expr --"):
        stdout, io = _out(line)
        assert stdout == b""
        assert _stderr_text(io) == (
            "expr: missing operand\n"
            "Try 'expr --help' for more information.\n")
        assert io.exit_code == 2


# `quote_word` itself is covered where it lives, in
# tests/commands/builtin/utils/test_quote.py: it is shared by nl, expand,
# shuf, cut and expr, and all five were measured to agree byte for byte
# (NL3-A). What belongs here is that expr reaches it from every clause
# that names a word.

# The same rule, reached through each of the four clauses that name a
# word, since GNU quotes in all of them and a fix applied to only one
# would pass a narrower test.
QUOTED_CLAUSES = [
    ((b"1", b"a\\b"), r"unexpected argument 'a\\b'"),
    ((b"substr", b"abc", b"a\\b"), r"missing argument after 'a\\b'"),
    ((b"(", b"a\\b"), r"expecting ')' after 'a\\b'"),
    ((b"(", b"1", b"a\\b"), r"expecting ')' instead of 'a\\b'"),
    ((b"1", b"a'b"), r"unexpected argument 'a\'b'"),
    ((b"(", "\u00e9".encode()), r"expecting ')' after '\303\251'"),
    ((b"(", b"a\tb"), r"expecting ')' after 'a\tb'"),
    ((b"(", b""), "expecting ')' after ''"),
]


@pytest.mark.parametrize("words,detail", QUOTED_CLAUSES)
def test_expr_quotes_the_word_in_every_clause(words, detail):
    texts = [w.decode("utf-8", "surrogateescape") for w in words]
    with pytest.raises(ExprError) as caught:
        _expr_eval([to_byte_view(t) for t in texts])
    assert str(caught.value) == f"expr: syntax error: {detail}"


# GNU picks between two clauses for an unclosed parenthesis on one fact:
# whether the line ran out (`after <last consumed>`) or a word is
# standing where the `)` belonged (`instead of <that word>`).
CLOSE_CLAUSES = [
    # Ran out: `after`, naming the last word consumed.
    (["(", "1", "+", "2"], "expecting ')' after '2'"),
    (["(", "1"], "expecting ')' after '1'"),
    (["(", "length", "ab"], "expecting ')' after 'ab'"),
    # The last word consumed can itself be a `)`, from an inner group.
    (["(", "(", "1", ")"], "expecting ')' after ')'"),
    # A word stands there: `instead of`, naming that word and not the
    # one before it.
    (["(", "1", "1"], "expecting ')' instead of '1'"),
    (["(", "1", "2", ")"], "expecting ')' instead of '2'"),
    (["(", "1", "+", "2", "3"], "expecting ')' instead of '3'"),
    (["(", "1", "=", "2", "x"], "expecting ')' instead of 'x'"),
    (["(", "length", "ab", "y"], "expecting ')' instead of 'y'"),
    (["(", "\\|", "1"], "expecting ')' instead of '1'"),
    (["(", "(", "1", "2"], "expecting ')' instead of '2'"),
    (["(", "1", "", ")"], "expecting ')' instead of ''"),
    # An operator with nothing to its right still outranks the unclosed
    # parenthesis: the inner expression refuses first.
    (["(", "1", "+"], "missing argument after '+'"),
    (["(", "1", "|"], "missing argument after '|'"),
    (["(", "1", ":"], "missing argument after ':'"),
    (["(", "substr", "a", "1"], "missing argument after '1'"),
    # A complete group with a leftover `)` is the ordinary leftover
    # clause, not either of the two above.
    (["(", "1", ")", ")"], "unexpected argument ')'"),
]


@pytest.mark.parametrize("args,detail", CLOSE_CLAUSES)
def test_expr_unclosed_paren_picks_after_or_instead_of(args, detail):
    with pytest.raises(ExprError) as caught:
        _expr_eval(list(args))
    assert str(caught.value) == f"expr: syntax error: {detail}"


def test_expr_digit_chunker_fast_path_agrees_with_the_chunked_path():
    # Both conversions short-circuit to `int`/`str` under the chunk
    # width, because that is the path every operand anyone writes takes
    # and rebuilding `10**4000` for a two-digit sum made rendering one
    # 250x slower than `str`. The shortcut has to answer identically.
    for body in ("0", "7", "1" + "0" * 3999, "1" + "0" * 4000,
                 "1" + "0" * 4000 + "1", "9" * 4301):
        chunked = 0
        for start in range(0, len(body), DIGIT_CHUNK):
            chunk = body[start:start + DIGIT_CHUNK]
            chunked = chunked * 10**len(chunk) + int(chunk)
        assert int_of_digits(body) == chunked
        assert int_of_digits("-" + body) == -chunked


def test_expr_digit_chunker_round_trips_past_the_cpython_cap():
    # CPython caps a base-10 `int(str)` / `str(int)` at 4300 digits, so
    # both conversions work in chunks. The awkward widths are the chunk
    # boundary itself and a value with interior zeros, which a chunker
    # that forgot to zero-pad would silently shorten.
    for body in ("0", "7", "1" + "0" * 3999, "1" + "0" * 4000,
                 "1" + "0" * 4000 + "1", "9" * 4301, "1" + "0" * 8000,
                 "9" * 8001, "1" + "0" * 4000 + "1" + "0" * 4000):
        assert digits_of_int(int_of_digits(body)) == body
        assert digits_of_int(
            int_of_digits("-" + body)) == ("-" + body if body != "0" else "0")


def test_expr_is_arbitrary_precision_past_the_cpython_cap():
    # GNU answers these; a bare `int(text)` raised `ValueError` and the
    # executor rendered it as `expr: <python message>` with exit 1.
    over = "1" + "0" * 4300
    assert _expr_eval([over, "+", "0"]) == (over, 0)
    assert _expr_eval(["2", "<", "1" + "0" * 8000]) == ("1", 0)
    assert _expr_eval(["-" + "9" * 4301, "<", "2"]) == ("1", 0)
    assert _expr_eval([over, "%", "7"]) == ("4", 0)
    assert _expr_eval(["1" + "0" * 8000, "%", "7"]) == ("2", 0)
    # The result side too: the product is 4400 digits, over the cap even
    # though neither operand is.
    value, code = _expr_eval(["9" * 2200, "*", "9" * 2200])
    assert (len(value), code) == (4400, 0)
    assert value == digits_of_int(int_of_digits("9" * 2200)**2)


def test_expr_syntax_error_wordings():
    for args, detail in (
        (["1", "+"], "missing argument after '+'"),
        (["1", "2"], "unexpected argument '2'"),
        (["1", "2", "3"], "unexpected argument '2'"),
        (["1", "?", "2"], "unexpected argument '?'"),
        (["1", "+", "2", ")"], "unexpected argument ')'"),
        (["(", "1", "+", "2"], "expecting ')' after '2'"),
            # The same error with a word standing in the `)`'s place is
            # a different clause naming a different word.
        (["(", "1", "1"], "expecting ')' instead of '1'"),
            # The one detail clause with no `argument` noun in it.
        (["(", ")"], "unexpected ')'"),
    ):
        with pytest.raises(ExprError) as caught:
            _expr_eval(list(args))
        assert str(caught.value) == f"expr: syntax error: {detail}"


def test_expr_syntax_error_is_empty_stdout_and_exit_two():
    stdout, io = _out("expr 1 2 3")
    assert stdout == b""
    assert _stderr_text(io) == "expr: syntax error: unexpected argument '2'\n"
    assert io.exit_code == 2


def _eval_bytes(*words: bytes) -> tuple[bytes, int]:
    """One expr line on raw operand bytes, answering raw output bytes.

    The command decodes argv with `surrogateescape` and hands every word
    to `to_byte_view`, so a test that starts from bytes travels the same
    road and can assert the bytes GNU wrote.

    Args:
        *words (bytes): the expression words, exactly as argv carries
            them.

    Returns:
        tuple[bytes, int]: stdout without its newline, and the exit code.
    """
    texts = [w.decode("utf-8", "surrogateescape") for w in words]
    value, code = _expr_eval([to_byte_view(t) for t in texts])
    return from_byte_view(value), code


# Every row is a measured GNU coreutils 9.4 answer under `LC_ALL=C`,
# recorded in the round-8 (`EX2`) truth table. expr has no characters,
# only bytes: `length` counts them, `index` searches a set of them,
# `substr` will split one in half, and the BRE's `.` matches one. The
# same rows are mirrored in expr.test.ts.
BYTE_SEMANTICS = [
    # `length` is a byte count, so a two-byte character counts twice and
    # a newline counts once.
    ((b"length", "éé".encode()), b"4", 0),
    ((b"length", "é".encode()), b"2", 0),
    ((b"length", "日本語".encode()), b"9", 0),
    ((b"length", b"a\xffb"), b"3", 0),
    ((b"length", b"\xff\xfe"), b"2", 0),
    ((b"length", "𐂀".encode()), b"4", 0),
    ((b"length", b"12\n"), b"3", 0),
    # `index` is `strcspn` over a set of BYTES, so a byte shared with a
    # different character matches: `a`-umlaut is `c3 a4` and `e`-acute is
    # `c3 a9`, and they share the leading `c3`.
    ((b"index", "éé".encode(), "é".encode()), b"1", 0),
    ((b"index", "abcéde".encode(), "é".encode()), b"4", 0),
    ((b"index", "ä".encode(), "é".encode()), b"1", 0),
    ((b"index", "abä".encode(), "é".encode()), b"3", 0),
    ((b"index", b"a\xff", b"\xff"), b"2", 0),
    ((b"index", "éé".encode(), b""), b"0", 1),
    # `substr` slices bytes, so it splits a character and prints the half
    # -- invalid UTF-8 on stdout, which is what GNU writes.
    ((b"substr", "éé".encode(), b"1", b"1"), b"\xc3", 0),
    ((b"substr", "éé".encode(), b"1", b"2"), b"\xc3\xa9", 0),
    ((b"substr", "éé".encode(), b"2", b"2"), b"\xa9\xc3", 0),
    ((b"substr", "éé".encode(), b"2", b"1"), b"\xa9", 0),
    ((b"substr", "éé".encode(), b"1", b"3"), b"\xc3\xa9\xc3", 0),
    ((b"substr", "éé".encode(), b"4", b"1"), b"\xa9", 0),
    ((b"substr", "éé".encode(), b"5", b"1"), b"", 1),
    ((b"substr", b"a\xffb", b"2", b"1"), b"\xff", 0),
    # The BRE runs over bytes too, so the match length is a byte count
    # and a group's text can be one byte of a character.
    (("éé".encode(), b":", b".*"), b"4", 0),
    (("éé".encode(), b":", b"."), b"1", 0),
    (("é".encode(), b":", b"."), b"1", 0),
    (("é".encode(), b":", b".."), b"2", 0),
    (("é".encode(), b":", b"..."), b"0", 1),
    (("é".encode(), b":", b"\\(.\\)"), b"\xc3", 0),
    (("éé".encode(), b":", b"\\(..\\)"), b"\xc3\xa9", 0),
    ((b"match", "éé".encode(), b"\\(..\\)"), b"\xc3\xa9", 0),
    (("ééx".encode(), b":", b"[^x]*"), b"4", 0),
    # A multibyte pattern is a sequence of bytes, and an interval binds
    # to the last of them: the pattern is `c3` then two `a9`.
    (("éé".encode(), b":", "é".encode()), b"2", 0),
    (("é".encode(), b":", b"[" + "é".encode() + b"]"), b"1", 0),
    ((b"a", b":", b"[" + "é".encode() + b"]"), b"0", 1),
    (("ééé".encode(), b":", "é".encode() + b"\\{2\\}"), b"0", 1),
    # The C locale's classes are ASCII, so neither matches a byte above
    # 0x7f -- which is what bre.py's inlined expansions already emit.
    (("é".encode(), b":", b"[[:alpha:]]*"), b"0", 1),
    (("é".encode(), b":", b"\\w*"), b"0", 1),
    ((b"a\xffb", b":", b"a.b"), b"3", 0),
    ((b"a\xffb", b":", b".*"), b"3", 0),
]


@pytest.mark.parametrize("words,out,code", BYTE_SEMANTICS)
def test_expr_string_operators_count_bytes(words, out, code):
    assert _eval_bytes(*words) == (out, code)


# The same lines the integ and conformance batteries type, so the quoting
# an operator needs to reach expr intact is pinned here too. The list is
# mirrored in expr.test.ts.
SHELL_LINES = [
    ("expr 1 + 2 + 3", "6\n", "", 0),
    ("expr '(' 2 + 3 ')' '*' 4", "20\n", "", 0),
    ("expr length '(' abc ')'", "3\n", "", 0),
    ("expr length abcde", "5\n", "", 0),
    ("expr index abcde ec", "3\n", "", 0),
    ("expr substr abcde 2 3", "bcd\n", "", 0),
    ("expr substr abcde 0 3", "\n", "", 1),
    ("expr substr abc x 1", "\n", "", 1),
    (r"expr match abcdef 'a\(bc\)'", "bc\n", "", 0),
    (r"expr abc ':' '[[:alpha:]]\+'", "3\n", "", 0),
    ("expr 'a+b' ':' 'a+b'", "3\n", "", 0),
    (r"expr abc ':' 'a\|b'", "1\n", "", 0),
    ("expr abc ':' 'a|b'", "0\n", "", 1),
    (r"expr aab ':' 'a\{2\}'", "2\n", "", 0),
    ("expr aab ':' 'a{2}'", "0\n", "", 1),
    ("expr '*a' ':' '*a'", "2\n", "", 0),
    (r"expr abc ':' '\w\+'", "3\n", "", 0),
    (r"expr aab ':' '\(a\)\1'", "a\n", "", 0),
    ("expr 1 '|' 1 '/' 0", "1\n", "", 0),
    ("expr 0 '&' 1 '/' 0", "0\n", "", 1),
    ("expr 2 '|' 0 '&' 0", "2\n", "", 0),
    ("expr 10 '%' 4 '*' 2", "4\n", "", 0),
    ("expr -5 + 3", "-2\n", "", 0),
    ("expr + length", "length\n", "", 0),
    ("expr 1 + + 2", "3\n", "", 0),
    ("expr '+1' '=' 1", "0\n", "", 1),
    ("expr 1 '==' 1", "1\n", "", 0),
    ("expr -- 1 + 2", "3\n", "", 0),
    ("expr -- --version", "--version\n", "", 0),
    ("expr", "", "expr: missing operand\n"
     "Try 'expr --help' for more information.\n", 2),
    ("expr --", "", "expr: missing operand\n"
     "Try 'expr --help' for more information.\n", 2),
    ("expr 1 +", "", "expr: syntax error: missing argument after '+'\n", 2),
    ("expr 1 2 3", "", "expr: syntax error: unexpected argument '2'\n", 2),
    ("expr '(' 1 + 2", "", "expr: syntax error: expecting ')' after '2'\n", 2),
    ("expr '(' ')'", "", "expr: syntax error: unexpected ')'\n", 2),
    (r"expr abc ':' '\('", "", "expr: Unmatched ( or \\(\n", 2),
    # The byte rows that still render as valid UTF-8, so the whole shell
    # path is pinned and not only `_expr_eval`.
    ("expr length \u00e9\u00e9", "4\n", "", 0),
    ("expr substr \u00e9\u00e9 1 2", "\u00e9\n", "", 0),
    ("expr index \u00e4 \u00e9", "1\n", "", 0),
    ("expr 2 '<' " + "1" + "0" * 320, "1\n", "", 0),
    ("expr 2 '>' " + "1" + "0" * 320, "0\n", "", 1),
    ("expr 1000000000000 '*' 1000000000000", "1" + "0" * 24 + "\n", "", 0),
    ("expr substr \u00e9\u00e9 3 2", "\u00e9\n", "", 0),
    ("expr \u00e9 ':' '..'", "2\n", "", 0),
    (r"expr $'12\n' + 1", "", "expr: non-integer argument\n", 2),
    # The two diagnostic-wording families, through the whole shell path:
    # gnulib's quote() escaping the word, and the `instead of` clause.
    (r"expr a '\(' 2", "", "expr: syntax error: unexpected argument '\\\\('\n",
     2),
    (r"expr '(' '\('", "", "expr: syntax error: expecting ')' after '\\\\('\n",
     2),
    ("expr '(' \u00e9", "",
     "expr: syntax error: expecting ')' after '\\303\\251'\n", 2),
    (r"expr '(' $'a\tb'", "",
     "expr: syntax error: expecting ')' after 'a\\tb'\n", 2),
    ("expr '(' 1 1", "", "expr: syntax error: expecting ')' instead of '1'\n",
     2),
    ("expr '(' 1 2 ')'", "",
     "expr: syntax error: expecting ')' instead of '2'\n", 2),
    ("expr '(' 1", "", "expr: syntax error: expecting ')' after '1'\n", 2),
    ("expr '(' 1 +", "", "expr: syntax error: missing argument after '+'\n",
     2),
]


@pytest.mark.parametrize("line,out,err,code", SHELL_LINES)
def test_expr_through_the_shell(line, out, err, code):
    stdout, io = _out(line)
    assert (stdout.decode(), _stderr_text(io), io.exit_code) == (out, err,
                                                                 code)


def test_expr_writes_the_bytes_a_split_character_leaves():
    # The whole way through the shell: `substr` cut the first character
    # in half, so stdout is one invalid byte and not a replacement
    # character. GNU writes `\xa9\xc3` here.
    stdout, io = _out("expr substr \u00e9\u00e9 2 2")
    assert stdout == b"\xa9\xc3\n"
    assert io.exit_code == 0
