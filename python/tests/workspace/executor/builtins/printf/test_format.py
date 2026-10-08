import pytest

from mirage.shell.bytes import encode_text
from mirage.workspace.executor.builtins.printf.format import run_printf

# GNU pins taken in debian:stable-slim. `handle_printf` collapses the
# message list into one stderr blob and a status, so the list itself —
# order and count — is only observable here.

# bash 5.2.37 through `od -An -tx1`: the format reads \NNN, one to three
# octal digits, and a %b argument also reads \0NNN, a leading 0 and up
# to three more.
_OCTAL_PINS = [
    ("\\0003", "00 33", "03"),
    ("\\0", "00", "00"),
    ("\\00", "00", "00"),
    ("\\000", "00", "00"),
    ("\\0000", "00 30", "00"),
    ("\\08", "00 38", "00 38"),
    ("\\101", "41", "41"),
    ("\\1011", "41 31", "41 31"),
    ("\\0101", "08 31", "41"),
    ("\\400", "00", "00"),
    ("\\0400", "20 30", "00"),
]

# bash 5.2.37 under LC_ALL=C.UTF-8 through `od -An -tx1`: the format and
# a %b argument UTF-8-encode \u and \U values, so a surrogate half
# and a value past Unicode come out UTF-8-shaped, and 0x80000000 and
# past come out as nothing.
_UNICODE_PINS = [
    ("\\uD800", "ed a0 80"),
    ("\\uDC80", "ed b2 80"),
    ("\\uDFFF", "ed bf bf"),
    ("\\uD83D\\uDE00", "ed a0 bd ed b8 80"),
    ("\\U00110000", "f4 90 80 80"),
    ("\\U0010FFFF", "f4 8f bf bf"),
    ("\\U7FFFFFFF", "fd bf bf bf bf bf"),
    ("\\U80000000", ""),
    ("\\UFFFFFFFF", ""),
    ("x\\UFFFFFFFFy", "78 79"),
    ("a\\u0000b", "61 00 62"),
    ("\\uDC80\\xff", "ed b2 80 ff"),
]


def _od(text: str) -> str:
    return encode_text(text).hex(" ")


def test_errors_come_back_as_a_list_in_argument_order():
    out, messages, failed, _ = run_printf("%d %d\n", ["abc", "def"])
    assert out == "0 0\n"
    assert messages == [
        "printf: abc: invalid number\n",
        "printf: def: invalid number\n",
    ]
    assert failed


def test_a_cycle_consuming_nothing_ends_the_reuse():
    # `a%%b` has no conversion, so the first cycle consumes no argument
    # and the excess args are dropped rather than looping forever; the
    # first one dropped comes back for coreutils' warning.
    assert run_printf("a%%b\n", ["x", "y", "z"]) == ("a%b\n", [], False, "x")


def test_empty_format_drops_every_argument():
    assert run_printf("", ["a", "b", "c"]) == ("", [], False, "a")


def test_a_reused_format_drops_nothing():
    assert run_printf("%s-%s\n", ["a", "b", "c"]) == (
        "a-b\nc-\n",
        [],
        False,
        None,
    )


def test_c_in_the_format_drops_nothing_to_warn_about():
    assert run_printf("x\\c", ["a"]) == ("x", [], False, None)


def test_stop_from_b_suppresses_the_rest_of_the_format():
    assert run_printf("[%b][%s]\n", ["ab\\ccd", "tail"]) == (
        "[ab",
        [],
        False,
        None,
    )


def test_stop_from_b_on_a_later_cycle_ends_every_cycle():
    assert run_printf("<%b>", ["one", "tw\\co", "three"]) == (
        "<one><tw",
        [],
        False,
        None,
    )


@pytest.mark.parametrize(
    "value,expected",
    [
        ("0.5", "0"),
        ("1.5", "2"),
        ("2.5", "2"),
        ("3.5", "4"),
    ],
)
def test_fixed_precision_rounds_half_to_even(value, expected):
    assert run_printf("%.0f", [value]) == (expected, [], False, None)


def test_a_missing_argument_is_the_empty_string_or_zero():
    assert run_printf("[%s][%d]", []) == ("[][0]", [], False, None)


@pytest.mark.parametrize("escape,in_format,in_b_arg", _OCTAL_PINS)
def test_octal_reads_three_digits_in_the_format_and_zero_plus_three_in_b(
    escape, in_format, in_b_arg
):
    fmt_out, fmt_messages, fmt_failed, _ = run_printf(escape, [])
    b_out, b_messages, b_failed, _ = run_printf("%b", [escape])
    assert (_od(fmt_out), fmt_messages, fmt_failed) == (in_format, [], False)
    assert (_od(b_out), b_messages, b_failed) == (in_b_arg, [], False)


@pytest.mark.parametrize("escape,expected", _UNICODE_PINS)
def test_unicode_escapes_are_utf8_encoded(escape, expected):
    fmt_out, fmt_messages, fmt_failed, _ = run_printf(escape, [])
    b_out, b_messages, b_failed, _ = run_printf("%b", [escape])
    assert (_od(fmt_out), fmt_messages, fmt_failed) == (expected, [], False)
    assert (_od(b_out), b_messages, b_failed) == (expected, [], False)


_HEX_WARNING = "printf: missing hex digit for \\x\n"

_ABC_INVALID = "printf: abc: invalid number\n"

_DEF_INVALID = "printf: def: invalid number\n"

# bash 5.2.37: an escape with no hex digit after it is written as it
# stands and warns on stderr, in the format and in a %b argument alike,
# and the status stays 0.
_MISSING_DIGIT_PINS = [
    ("\\x|", [_HEX_WARNING]),
    ("\\xg", [_HEX_WARNING]),
    ("\\x", [_HEX_WARNING]),
    (
        "\\u|\\U|",
        [
            "printf: missing unicode digit for \\u\n",
            "printf: missing unicode digit for \\U\n",
        ],
    ),
]


@pytest.mark.parametrize("escapes,warnings", _MISSING_DIGIT_PINS)
def test_an_escape_without_digits_warns_and_does_not_fail(escapes, warnings):
    assert run_printf(escapes, []) == (escapes, warnings, False, None)
    assert run_printf("%b", [escapes]) == (escapes, warnings, False, None)


def test_warnings_and_invalid_numbers_come_back_in_scan_order():
    warning_first = run_printf("\\x%d\n", ["abc"])
    error_first = run_printf("%d\\x\n", ["abc"])
    b_after_error = run_printf("%d%b\n", ["abc", "\\x"])
    assert warning_first == (
        "\\x0\n",
        [_HEX_WARNING, _ABC_INVALID],
        True,
        None,
    )
    assert error_first == ("0\\x\n", [_ABC_INVALID, _HEX_WARNING], True, None)
    assert b_after_error == (
        "0\\x\n",
        [_ABC_INVALID, _HEX_WARNING],
        True,
        None,
    )


def test_a_reused_format_warns_once_per_pass():
    two_passes = run_printf("\\x%s\n", ["a", "b"])
    one_pass = run_printf("\\x\n", ["a", "b"])
    assert two_passes == (
        "\\xa\n\\xb\n",
        [_HEX_WARNING, _HEX_WARNING],
        False,
        None,
    )
    assert one_pass == ("\\x\n", [_HEX_WARNING], False, "a")


def test_b_warns_up_to_its_stop_and_before_its_precision():
    assert run_printf("%b\n", ["a\\cb\\x"]) == ("a", [], False, None)
    assert run_printf("%.1b\n", ["\\xy"]) == (
        "\\\n",
        [_HEX_WARNING],
        False,
        None,
    )


# bash 5.2.37: %b's \c returns from printf with the status it has so
# far, before the end of the builtin folds an invalid number into it.
def test_a_stop_from_b_reports_no_failure_after_an_invalid_number():
    assert run_printf("%d%b", ["abc", "\\c"]) == (
        "0",
        [_ABC_INVALID],
        False,
        None,
    )
    mid_argument = run_printf("%d%b\n", ["abc", "x\\cy"])
    later_pass = run_printf("%d%b", ["abc", "x", "def", "\\c"])
    assert mid_argument == ("0x", [_ABC_INVALID], False, None)
    assert later_pass == ("0x0", [_ABC_INVALID, _DEF_INVALID], False, None)


def test_an_invalid_number_after_the_stop_is_never_read():
    assert run_printf("%b%d", ["\\c", "abc"]) == ("", [], False, None)


def test_an_invalid_number_without_a_stop_still_fails():
    assert run_printf("%d%b", ["abc", "x"]) == (
        "0x",
        [_ABC_INVALID],
        True,
        None,
    )
