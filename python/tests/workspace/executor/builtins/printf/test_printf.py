import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.commands.spec import SPECS
from mirage.commands.spec.help import render_help
from mirage.context import reset_program_invocation, set_program_invocation
from mirage.io.stream import materialize
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
    (["[%.0d]", "0"], b"[]", 0),
    (["[% d]", "-5"], b"[-5]", 0),
    (["%X\n", "-1"], b"FFFFFFFFFFFFFFFF\n", 0),
    (["%#o\n", "0"], b"0\n", 0),
    (["%e\n", "0"], b"0.000000e+00\n", 0),
    (["%g\n", "100000"], b"100000\n", 0),
    (["%g\n", "0.00001"], b"1e-05\n", 0),
    (["%d\n", "3.9"], b"3\n", 1),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("args,expected,code", PRINTF_CASES)
async def test_printf_matches_gnu(args, expected, code):
    assert await printf_result(args) == (expected, code)


@pytest.mark.asyncio
async def test_printf_no_args_is_a_usage_error():
    out, io, _ = await handle_printf([], SessionState(session_id="s1"))
    assert (out, io.exit_code) == (None, 2)
    assert io.stderr == b"printf: usage: printf [-v var] format [arguments]\n"


# bash's option scan takes single letters, so it reports the first
# character it does not know spelled with ONE dash: a long spelling
# answers for its second dash and its own text never reaches the
# message. Measured on bash 5.2.21, where the coreutils binary of the
# same name is lenient and prints the word; mirage ships the builtin.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "args,bad",
    [
        (["--zzz"], "--"),
        (["--zzz=x"], "--"),
        (["--hel"], "--"),
        (["--help=x"], "--"),
        (["--version"], "--"),
        (["-Q"], "-Q"),
    ],
)
async def test_printf_unknown_option_reports_the_first_character(args, bad):
    _, io, node = await handle_printf(args, SessionState(session_id="s1"))
    assert io.exit_code == 2
    assert (
        io.stderr
        == (
            f"bash: printf: {bad}: invalid option\n"
            f"printf: usage: printf [-v var] format [arguments]\n"
        ).encode()
    )
    assert node.exit_code == 2


# bash answers the EXACT word `--help` for every builtin ahead of
# its option scan, writing the page to STDOUT and exiting 2, where
# `--hel` and `--version` take the invalid-option path above (measured
# on bash 5.2.37).
@pytest.mark.asyncio
async def test_printf_help_prints_the_page_to_stdout_and_exits_2():
    out, io, node = await handle_printf(
        ["--help"], SessionState(session_id="s1")
    )
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
    assert _HELP.endswith(
        "    Exit Status:\n"
        "    Returns success unless an invalid option is "
        "given or a write or assignment\n"
        "    error occurs.\n"
    )


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
async def test_printf_inf_and_nan():
    assert await printf_bytes(["%f\n", "-inf"]) == b"-inf\n"


@pytest.mark.asyncio
async def test_printf_char_empty_is_nul():
    assert await printf_bytes(["[%c]", ""]) == b"[\x00]"


@pytest.mark.asyncio
async def test_printf_unicode_escapes():
    assert await printf_bytes(["\\U0001F600"]) == "😀".encode()


@pytest.mark.asyncio
async def test_printf_hex_and_octal_escapes_name_bytes():
    assert await printf_bytes(["\\x41\\x42"]) == b"AB"


@pytest.mark.asyncio
async def test_printf_quote_shell():
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
    assert io.stderr == b"bash: printf: `1bad': not a valid identifier\n"


@pytest.mark.asyncio
async def test_printf_v_empty_subscript_is_not_an_identifier():
    session = SessionState(session_id="s1")
    out, io, node = await handle_printf(["-v", "a[]", "x"], session)
    assert node.exit_code == 2
    assert io.stderr == b"bash: printf: `a[]': not a valid identifier\n"
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
    assert io.stderr == (
        b"bash: printf: nope: invalid number\nbash: A: readonly variable\n"
    )
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


async def program_printf(args: list[str]) -> tuple[bytes | None, bytes, int]:
    session = SessionState(session_id="s1")
    token = set_program_invocation(session)
    try:
        out, io, node = await handle_printf(args, session)
    finally:
        reset_program_invocation(token)
    assert io.exit_code == node.exit_code
    return (
        out if isinstance(out, bytes) else None,
        await materialize(io.stderr),
        node.exit_code,
    )


def _excess(word: str) -> bytes:
    return (
        f"printf: warning: ignoring excess arguments, starting with {word}\n"
    ).encode()


# coreutils 9.7 (debian:stable-slim), which a program run answers as.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "args, out, err",
    [
        (["x\n", "a", "b"], b"x\n", _excess("'a'")),
        (["%%s\n", "x"], b"%s\n", _excess("'x'")),
        (["", "a"], b"", _excess("'a'")),
        (["x\n", "it's"], b"x\n", _excess("'it\\'s'")),
        (["x\n", "é"], b"x\n", _excess("'\\303\\251'")),
        (["x\n", "a\tb"], b"x\n", _excess("'a\\tb'")),
        (["x\n", ""], b"x\n", _excess("''")),
        (["--", "x\n", "a"], b"x\n", _excess("'a'")),
        (["-v", "v", "x\n"], b"-v", _excess("'v'")),
        (["%s-%s\n", "a", "b", "c"], b"a-b\nc-\n", b""),
        (["x\\c", "a"], b"x", b""),
    ],
)
async def test_printf_run_as_a_program_warns_about_what_it_drops(
    args: list[str], out: bytes, err: bytes
):
    assert await program_printf(args) == (out, err, 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("args", [[], ["--"]])
async def test_printf_run_as_a_program_needs_a_format(args: list[str]):
    assert await program_printf(args) == (
        None,
        b"printf: missing operand\n"
        b"Try 'printf --help' for more information.\n",
        1,
    )


@pytest.mark.asyncio
async def test_printf_builtin_drops_excess_arguments_silently():
    out, io, _ = await handle_printf(["x\n", "a"], SessionState("s1"))
    assert (out, io.stderr, io.exit_code) == (b"x\n", None, 0)


# Each of these execs its command, so printf is coreutils' there.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, word",
    [
        ("env printf 'x\\n' a", "a"),
        ("echo a | xargs printf 'x\\n'", "a"),
        ("timeout 5 printf 'x\\n' a", "a"),
        ("find /data -maxdepth 0 -exec printf 'x\\n' {} \\;", "/data"),
    ],
)
async def test_printf_under_a_command_runner_is_the_program(
    line: str, word: str
):
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell(line)
    assert await materialize(io.stdout) == b"x\n"
    assert await materialize(io.stderr) == _excess(f"'{word}'")
    assert io.exit_code == 0


# A function one of them runs is shell code, whose printf is the shell's.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "runner", ["env g", "echo a | xargs g", "timeout 5 g"]
)
async def test_printf_in_a_function_a_command_runner_runs_is_the_builtin(
    runner: str,
):
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    io = await ws.shell(
        "g() { printf -v r ok; printf 'x\\n' extra; "
        f'echo "[$r]"; }}; {runner}'
    )
    assert await materialize(io.stdout) == b"x\n[ok]\n"
    assert await materialize(io.stderr) == b""
    assert io.exit_code == 0


# bash 5.2.37: an escape missing its digits writes a `bash: printf:`
# warning to stderr and leaves the status alone.
@pytest.mark.asyncio
async def test_printf_missing_digit_warns_and_exits_0():
    out, io, node = await handle_printf(
        ["\\x|"], SessionState(session_id="s1")
    )
    assert out == b"\\x|"
    assert io.exit_code == 0
    assert io.stderr == b"bash: printf: missing hex digit for \\x\n"
    assert node.exit_code == 0
    assert node.stderr == b"bash: printf: missing hex digit for \\x\n"


@pytest.mark.asyncio
async def test_printf_v_missing_digit_warns_and_still_assigns():
    session = SessionState(session_id="s1")
    out, io, node = await handle_printf(["-v", "V", "%b", "\\U"], session)
    assert out is None
    assert node.exit_code == 0
    assert io.stderr == b"bash: printf: missing unicode digit for \\U\n"
    assert session.env["V"] == "\\U"


@pytest.mark.asyncio
async def test_printf_v_readonly_writes_the_warning_before_the_refusal():
    session = SessionState(session_id="s1")
    seed_var(session, "R", "orig")
    set_attr(session, "R", VarAttr.READONLY)
    out, io, node = await handle_printf(["-v", "R", "\\x"], session)
    assert node.exit_code == 1
    assert io.stderr == (
        b"bash: printf: missing hex digit for \\x\nbash: R: readonly variable\n"
    )
    assert session.env["R"] == "orig"


# bash 5.2.37: %b's \c returns before an invalid number reaches the
# status, with or without -v; a readonly -v target still fails.
@pytest.mark.asyncio
async def test_printf_stop_from_b_exits_0_after_an_invalid_number():
    out, io, node = await handle_printf(
        ["%d%b", "abc", "\\c"], SessionState(session_id="s1")
    )
    assert out == b"0"
    assert io.exit_code == 0
    assert io.stderr == b"bash: printf: abc: invalid number\n"
    assert node.exit_code == 0


@pytest.mark.asyncio
async def test_printf_v_stop_from_b_exits_0_and_still_assigns():
    session = SessionState(session_id="s1")
    out, io, node = await handle_printf(
        ["-v", "V", "%d%b", "abc", "x", "def", "\\c"], session
    )
    assert out is None
    assert node.exit_code == 0
    assert io.stderr == (
        b"bash: printf: abc: invalid number\nbash: printf: def: invalid number\n"
    )
    assert session.env["V"] == "0x0"


@pytest.mark.asyncio
async def test_printf_v_readonly_still_fails_after_a_stop_from_b():
    session = SessionState(session_id="s1")
    seed_var(session, "R", "orig")
    set_attr(session, "R", VarAttr.READONLY)
    out, io, node = await handle_printf(
        ["-v", "R", "%d%b", "abc", "\\c"], session
    )
    assert node.exit_code == 1
    assert io.stderr == (
        b"bash: printf: abc: invalid number\nbash: R: readonly variable\n"
    )
    assert session.env["R"] == "orig"
