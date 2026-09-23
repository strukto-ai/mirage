import pytest

from mirage.commands.spec import SPECS
from mirage.commands.spec.help import render_help
from mirage.shell.bytes import byte_char
from mirage.shell.variable import VarAttr
from mirage.workspace.executor.builtins.printf import handle_printf
from mirage.workspace.executor.builtins.printf.printf import _HELP
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import seed_var, set_attr


async def printf_result(args: list[str]) -> tuple[bytes, int]:
    out, io, node = await handle_printf(args, SessionState(session_id="s1"))
    assert isinstance(out, bytes)
    assert io.exit_code == node.exit_code
    return out, node.exit_code


async def printf_bytes(args: list[str]) -> bytes:
    out, code = await printf_result(args)
    assert code == 0
    return out


PRINTF_CASES = [
    (["%s\n", "c", "a", "b"], b"c\na\nb\n", 0),
    (["%d\n", "1", "2", "3"], b"1\n2\n3\n", 0),
    (["(%s,%s)", "a", "b", "c"], b"(a,b)(c,)", 0),
    (["hello\n", "a", "b", "c"], b"hello\n", 0),
    (["%s=%d;", "foo", "1", "bar"], b"foo=1;bar=0;", 0),
    (["a%%b\n"], b"a%b\n", 0),
    (["[%s][%s]\n", "x"], b"[x][]\n", 0),
    (["[%d][%d]\n", "5"], b"[5][0]\n", 0),
    (["[%-5s]", "hi"], b"[hi   ]", 0),
    (["[%5s]", "hi"], b"[   hi]", 0),
    (["[%.3s]", "abcdef"], b"[abc]", 0),
    (["[%05d]", "42"], b"[00042]", 0),
    (["[%-05d]", "42"], b"[42   ]", 0),
    (["[%.0d]", "0"], b"[]", 0),
    (["[%+d]", "5"], b"[+5]", 0),
    (["[% d]", "-5"], b"[-5]", 0),
    # integer bases + alt form + 64-bit wrap
    (["[%o][%u][%x][%X]\n", "64", "64", "255",
      "255"], b"[100][64][ff][FF]\n", 0),
    (["%x\n", "-1"], b"ffffffffffffffff\n", 0),
    (["%X\n", "-1"], b"FFFFFFFFFFFFFFFF\n", 0),
    (["%o\n", "-1"], b"1777777777777777777777\n", 0),
    (["%u\n", "-1"], b"18446744073709551615\n", 0),
    (["%#x\n", "255"], b"0xff\n", 0),
    (["%#X\n", "255"], b"0XFF\n", 0),
    (["%#o\n", "64"], b"0100\n", 0),
    (["%#x\n", "0"], b"0\n", 0),
    (["%#o\n", "0"], b"0\n", 0),
    (["%08x\n", "255"], b"000000ff\n", 0),
    (["%d\n", "0x1f"], b"31\n", 0),
    (["%d\n", "010"], b"8\n", 0),
    # quote-char numeric argument
    (["%d\n", '"A'], b"65\n", 0),
    (["%d\n", "'Z"], b"90\n", 0),
    # %c and %b
    (["[%c]\n", "abc"], b"[a]\n", 0),
    (["[%c%c]\n", "xy", "z"], b"[xz]\n", 0),
    (["[%b]\n", "a\\tb"], b"[a\tb]\n", 0),
    (["[%b]\n", "x\\101y"], b"[xAy]\n", 0),
    (["[%b]", "ab\\ccd"], b"[ab", 0),
    # dynamic width / precision
    (["[%*d]\n", "5", "42"], b"[   42]\n", 0),
    (["[%.*f]\n", "2", "3.14159"], b"[3.14]\n", 0),
    (["[%*.*f]\n", "10", "2", "3.14159"], b"[      3.14]\n", 0),
    (["[%*d]\n", "-5", "42"], b"[42   ]\n", 0),
    # floats
    (["%.2f\n", "3.14159"], b"3.14\n", 0),
    (["%.0f\n", "0.5"], b"0\n", 0),
    (["%.0f\n", "1.5"], b"2\n", 0),
    (["%.0f\n", "2.5"], b"2\n", 0),
    (["%010.2f\n", "3.14"], b"0000003.14\n", 0),
    (["%#.0f\n", "3"], b"3.\n", 0),
    (["%e\n", "0"], b"0.000000e+00\n", 0),
    (["%.2e\n", "12345.678"], b"1.23e+04\n", 0),
    (["%g\n", "100000"], b"100000\n", 0),
    (["%g\n", "1000000"], b"1e+06\n", 0),
    (["%g\n", "0.0001"], b"0.0001\n", 0),
    (["%g\n", "0.00001"], b"1e-05\n", 0),
    (["%#g\n", "1.5"], b"1.50000\n", 0),
    # backslash escapes in format (incl. octal and \u)
    (["x\\ty\\n"], b"x\ty\n", 0),
    (["\\101\\n"], b"A\n", 0),
    # invalid number: leading digits used, exit 1
    (["%d\n", "abc"], b"0\n", 1),
    (["%d\n", "3.9"], b"3\n", 1),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("args,expected,code", PRINTF_CASES)
async def test_printf_matches_gnu(args, expected, code):
    assert await printf_result(args) == (expected, code)


@pytest.mark.asyncio
async def test_printf_no_args_is_empty():
    assert await printf_bytes([]) == b""


# bash's `internal_getopt` takes single letters, so it reports the first
# character it does not know spelled with ONE dash: a long spelling
# answers for its second dash and its own text never reaches the
# message. Measured on bash 5.2.21, where the coreutils binary of the
# same name is lenient and prints the word; mirage ships the builtin.
@pytest.mark.asyncio
@pytest.mark.parametrize("args,bad", [(["--zzz"], "--"), (["--zzz=x"], "--"),
                                      (["--hel"], "--"), (["--help=x"], "--"),
                                      (["--version"], "--"), (["-Q"], "-Q")])
async def test_printf_unknown_option_reports_the_first_character(args, bad):
    _, io, node = await handle_printf(args, SessionState(session_id="s1"))
    assert io.exit_code == 2
    assert io.stderr == (
        f"printf: {bad}: invalid option\n"
        f"printf: usage: printf [-v var] format [arguments]\n").encode()
    assert node.exit_code == 2


# bash answers the EXACT word `--help` for every builtin ahead of
# `internal_getopt`, writing the page to STDOUT and exiting 2, where
# `--hel` and `--version` take the invalid-option path above (measured
# on bash 5.2.37).
@pytest.mark.asyncio
async def test_printf_help_prints_the_page_to_stdout_and_exits_2():
    out, io, node = await handle_printf(["--help"],
                                        SessionState(session_id="s1"))
    assert io.exit_code == 2
    assert not io.stderr
    assert b"".join([chunk async for chunk in out]) == _HELP.encode()
    assert node.exit_code == 2


# The page is the BUILTIN's, so it is bash's own text and not the
# spec-rendered one every other command answers --help with: the
# spec-rendered page cannot mention `-v`, which is the builtin's option
# alone and so is absent from CommandSpec by design. The first line is
# bash's synopsis, not GNU's `Usage:` line.
def test_printf_help_is_the_bash_builtin_page_not_the_spec_page():
    assert _HELP.startswith("printf: printf [-v var] format [arguments]\n")
    assert "  -v var\tassign the output to shell variable VAR" in _HELP
    assert _HELP != render_help("printf", SPECS["printf"])
    assert not _HELP.startswith("printf\n\nUsage:")


# Byte for byte bash 5.2.37's page, minus the two conversions mirage
# does not implement. Keeping the check explicit means adding `%Q` or
# `%(fmt)T` to the engine without adding it to the page fails here.
def test_printf_help_drops_only_the_conversions_mirage_lacks():
    assert "      %b\texpand backslash escape sequences" in _HELP
    assert "      %q\tquote the argument in a way" in _HELP
    assert "%Q" not in _HELP
    assert "%(fmt)T" not in _HELP
    # Everything else bash writes is present, in bash's words.
    assert _HELP.endswith("    Exit Status:\n"
                          "    Returns success unless an invalid option is "
                          "given or a write or assignment\n"
                          "    error occurs.\n")


@pytest.mark.asyncio
async def test_printf_dash_dash_ends_the_options():
    assert await printf_bytes(["--", "--zzz"]) == b"--zzz"


# `--` ends the options and the FORMAT is still required, so the line is
# the usage error rather than an empty one.
@pytest.mark.asyncio
async def test_printf_dash_dash_alone_is_the_usage_error():
    _, io, _ = await handle_printf(["--"], SessionState(session_id="s1"))
    assert io.exit_code == 2
    assert io.stderr == b"printf: usage: printf [-v var] format [arguments]\n"


# An option-shaped word in OPERAND position is a plain argument: bash
# stops scanning at the first non-option word.
@pytest.mark.asyncio
async def test_printf_option_shaped_operand_is_an_argument():
    assert await printf_bytes(["%s", "--zzz"]) == b"--zzz"


@pytest.mark.asyncio
async def test_printf_format_reuse_for_excess_args():
    assert await printf_bytes(["%s\n", "c", "a", "b"]) == b"c\na\nb\n"


@pytest.mark.asyncio
async def test_printf_no_conversion_ignores_excess_args():
    assert await printf_bytes(["hello\n", "a", "b", "c"]) == b"hello\n"


@pytest.mark.asyncio
async def test_printf_inf_and_nan():
    assert await printf_bytes(["%f|%e|%g\n", "inf", "inf", "inf"]) == \
        b"inf|inf|inf\n"
    assert await printf_bytes(["%f\n", "-inf"]) == b"-inf\n"
    assert await printf_bytes(["%F|%G\n", "nan", "nan"]) == b"NAN|NAN\n"


@pytest.mark.asyncio
async def test_printf_char_empty_is_nul():
    assert await printf_bytes(["[%c]", ""]) == b"[\x00]"


@pytest.mark.asyncio
async def test_printf_unicode_escapes():
    assert await printf_bytes(["\\u00e9\n"]) == "é\n".encode()
    assert await printf_bytes(["\\U0001F600"]) == "😀".encode()


@pytest.mark.asyncio
async def test_printf_hex_and_octal_escapes_name_bytes():
    # bash writes \xff as the byte 0xFF, which is not valid UTF-8 at
    # all, rather than as the code point U+00FF.
    assert await printf_bytes(["\\xff"]) == b"\xff"
    assert await printf_bytes(["\\377"]) == b"\xff"
    assert await printf_bytes(["\\xc3\\xa9"]) == "é".encode()
    assert await printf_bytes(["\\x41\\x42"]) == b"AB"
    assert await printf_bytes(["%b", "\\xff"]) == b"\xff"


@pytest.mark.asyncio
async def test_printf_quotes_a_raw_byte_as_octal():
    assert await printf_bytes(["%q\n", byte_char(0xFF)]) == b"$'\\377'\n"


@pytest.mark.asyncio
async def test_printf_quote_shell():
    assert await printf_bytes(["%q\n", "a b"]) == b"a\\ b\n"
    assert await printf_bytes(["%q\n", ""]) == b"''\n"
    assert await printf_bytes(["%q\n", "it's"]) == b"it\\'s\n"
    assert await printf_bytes(["%q\n", "ümlaut"]) == b"$'\\303\\274mlaut'\n"
    assert await printf_bytes(["%q\n", "tab\ttab"]) == b"$'tab\\ttab'\n"


@pytest.mark.asyncio
async def test_printf_hex_float_double_precision():
    # %a at IEEE double precision (differs from bash's long double)
    assert await printf_bytes(["%a\n", "1.0"]) == b"0x1p+0\n"
    assert await printf_bytes(["%a\n", "0.5"]) == b"0x1p-1\n"
    assert await printf_bytes(["%a\n", "3.14"]) == b"0x1.91eb851eb851fp+1\n"
    assert await printf_bytes(["%A\n", "255.5"]) == b"0X1.FFP+7\n"


@pytest.mark.asyncio
async def test_printf_invalid_number_reports_exit_1():
    out, code = await printf_result(["%d\n", "abc"])
    assert out == b"0\n"
    assert code == 1


@pytest.mark.asyncio
async def test_printf_v_assigns_variable_and_prints_nothing():
    session = SessionState(session_id="s1")
    out, io, node = await handle_printf(["-v", "V", "x=%d", "42"], session)
    assert out is None
    assert node.exit_code == 0
    assert session.env["V"] == "x=42"


@pytest.mark.asyncio
async def test_printf_v_targets_array_element():
    session = SessionState(session_id="s1")
    out, io, node = await handle_printf(["-v", "arr[2]", "hi"], session)
    assert out is None
    assert node.exit_code == 0
    # Indices 0 and 1 are holes, not empty elements.
    assert session.arrays["arr"] == [None, None, "hi"]


@pytest.mark.asyncio
async def test_printf_v_invalid_name_errors():
    session = SessionState(session_id="s1")
    out, io, node = await handle_printf(["-v", "1bad", "x"], session)
    assert node.exit_code == 2
    assert b"`1bad': not a valid identifier" in (io.stderr or b"")


@pytest.mark.asyncio
async def test_printf_v_invalid_name_suppresses_conversion_errors():
    session = SessionState(session_id="s1")
    out, io, node = await handle_printf(["-v", "1bad", "%d", "nope"], session)
    assert node.exit_code == 2
    assert io.stderr == b"printf: `1bad': not a valid identifier\n"


@pytest.mark.asyncio
async def test_printf_v_empty_subscript_is_not_an_identifier():
    session = SessionState(session_id="s1")
    out, io, node = await handle_printf(["-v", "a[]", "x"], session)
    assert node.exit_code == 2
    assert io.stderr == b"printf: `a[]': not a valid identifier\n"
    assert "a" not in session.arrays


@pytest.mark.asyncio
async def test_printf_v_blank_subscript_is_arithmetic_zero():
    session = SessionState(session_id="s1")
    out, io, node = await handle_printf(["-v", "a[ ]", "x"], session)
    assert node.exit_code == 0
    assert session.arrays["a"] == ["x"]


@pytest.mark.asyncio
async def test_printf_v_readonly_scalar_is_rejected():
    session = SessionState(session_id="s1")
    seed_var(session, "R", "orig")
    set_attr(session, "R", VarAttr.READONLY)
    out, io, node = await handle_printf(["-v", "R", "new"], session)
    assert node.exit_code == 1
    assert io.stderr == b"bash: R: readonly variable\n"
    assert session.env["R"] == "orig"


@pytest.mark.asyncio
async def test_printf_v_readonly_array_element_is_rejected():
    session = SessionState(session_id="s1")
    seed_var(session, "A", ["x", "y"])
    set_attr(session, "A", VarAttr.READONLY)
    out, io, node = await handle_printf(["-v", "A[0]", "%d", "nope"], session)
    assert node.exit_code == 1
    assert io.stderr == (b"printf: nope: invalid number\n"
                         b"bash: A: readonly variable\n")
    assert session.arrays["A"] == ["x", "y"]


@pytest.mark.asyncio
async def test_printf_v_scalar_target_keeps_other_array_elements():
    session = SessionState(session_id="s1")
    seed_var(session, "B", ["p", "q", "r"])
    out, io, node = await handle_printf(["-v", "B", "Q"], session)
    assert node.exit_code == 0
    assert session.arrays["B"] == ["Q", "q", "r"]
    assert "B" not in session.env


@pytest.mark.asyncio
async def test_printf_v_bad_subscript_keeps_the_scalar():
    session = SessionState(session_id="s1")
    seed_var(session, "V", "orig")
    out, io, node = await handle_printf(["-v", "V[-2]", "hi"], session)
    assert node.exit_code == 1
    assert io.stderr == b"bash: V[-2]: bad array subscript\n"
    assert session.env["V"] == "orig"
    assert "V" not in session.arrays


@pytest.mark.asyncio
async def test_printf_v_negative_subscript_wraps_over_the_scalar():
    session = SessionState(session_id="s1")
    seed_var(session, "W", "orig")
    out, io, node = await handle_printf(["-v", "W[-1]", "hi"], session)
    assert node.exit_code == 0
    assert session.arrays["W"] == ["hi"]
    assert "W" not in session.env


@pytest.mark.asyncio
async def test_printf_v_keeps_exit_1_on_bad_number_but_still_assigns():
    session = SessionState(session_id="s1")
    out, io, node = await handle_printf(["-v", "V", "%d", "notanum"], session)
    assert node.exit_code == 1
    assert session.env["V"] == "0"
