import pytest

from mirage.commands.builtin.sed_exec import (
    SedFileError,
    SedFileText,
    SedInput,
    SedMachine,
    SedRunOptions,
    list_line,
)
from mirage.commands.builtin.sed_script import SedScriptPiece, compile_script
from mirage.shell.bytes import byte_view, from_byte_view

pytestmark = pytest.mark.asyncio


async def _run(
    exprs: str | list[str],
    inputs: str | list[SedInput],
    *,
    suppress: bool = False,
    extended: bool = False,
    separate: bool = False,
    line_length: int = 70,
    files: dict | None = None,
) -> tuple[str, str, int, dict[str, str]]:
    pieces = [
        SedScriptPiece("expr", text)
        for text in ([exprs] if isinstance(exprs, str) else exprs)
    ]
    machine = SedMachine(
        compile_script(pieces, extended),
        SedRunOptions(
            suppress=suppress,
            separate=separate,
            line_length=line_length,
            files=files or {},
            reader_files=files or {},
        ),
    )
    output = "".join(
        [
            chunk
            async for chunk in machine.process(
                [SedInput("-", byte_view(inputs))]
                if isinstance(inputs, str)
                else inputs,
                True,
            )
        ]
    )
    wfiles = {
        name: "".join(out.chunks) for name, out in machine.wfiles.items()
    }
    return (
        output,
        machine.stderr(),
        machine.exit_code(),
        wfiles,
    )


async def _sed(expr: str, text: str, suppress: bool = False) -> str:
    return (await _run(expr, text, suppress=suppress))[0]


@pytest.mark.parametrize(
    "expr,text,expected",
    [
        ("a one\\/two", "x\n", "x\none/two\n"),
        ("i one\\/two", "x\n", "one/two\nx\n"),
        ("c one\\/two", "x\n", "one/two\n"),
        (
            "/^bibtexurl:/a codeurl: 'https:\\/\\/github.com\\/u\\/r'",
            "bibtexurl: x\n",
            "bibtexurl: x\ncodeurl: 'https://github.com/u/r'\n",
        ),
    ],
)
async def test_text_drops_backslash_before_ordinary_char(expr, text, expected):
    assert (await _sed(expr, text)) == expected


@pytest.mark.parametrize(
    "expr,expected",
    [
        ("a one\\/two\\tthree", "x\none/two\tthree\n"),
        ("a x\\ny", "x\nx\ny\n"),
        ("a x\\\\y", "x\nx\\y\n"),
        ("a x\\by", "x\nxby\n"),
        ("a 1\\a2\\f3\\v4\\r5", "x\n1\x072\f3\v4\r5\n"),
    ],
)
async def test_text_decodes_escapes(expr, expected):
    assert (await _sed(expr, "x\n")) == expected


async def test_text_decodes_numeric_and_control_escapes():
    assert (
        await _sed("a [\\d065][\\x41][\\o101][\\x4][\\xZ][\\d300]", "x\n")
    ) == "x\n[A][A][A][\x04][xZ][,]\n"
    assert (
        await _sed("a [\\cA][\\ca][\\c?][\\c\\\\]", "x\n")
    ) == "x\n[\x01][\x01][\x7f][\x1c]\n"
    with pytest.raises(
        ValueError, match=r"recursive escaping after \\c not allowed"
    ):
        (await _sed("a [\\c\\d]", "x\n"))


async def test_text_numeric_escapes_above_ascii_are_raw_bytes():
    out = await _sed(
        "a [\\xff][\\d200][\\o377][\\x80][\\xc3\\xa9][\\o400]", "x\n"
    )
    assert from_byte_view(out) == (
        b"x\n[\xff][\xc8][\xff][\x80][\xc3\xa9][\x00]\n"
    )


async def test_text_final_c_escape_takes_closing_newline():
    assert (await _sed("a foo\\c", "x\ny\n")) == "x\nfooJy\nfooJ"
    assert (await _sed("i foo\\c", "x\n")) == "foo\nx\n"


@pytest.mark.parametrize(
    "expr,expected",
    [
        ("a  \t foo", "x\nfoo\n"),
        ("a\\   foo", "x\n   foo\n"),
        ("a\\tfoo", "x\ntfoo\n"),
        ("a \\tfoo", "x\ntfoo\n"),
        ("a\\\\tfoo", "x\n\tfoo\n"),
    ],
)
async def test_text_leading_blanks(expr, expected):
    assert (await _sed(expr, "x\n")) == expected


@pytest.mark.parametrize(
    "expr,expected",
    [
        ("a\\\n  l1\\\n  l2", "x\n  l1\n  l2\n"),
        ("i\\\nl1\\\nl2", "l1\nl2\nx\n"),
        ("a foo\\\nbar", "x\nfoo\nbar\n"),
    ],
)
async def test_text_classic_form_and_continued_lines(expr, expected):
    assert (await _sed(expr, "x\n")) == expected


@pytest.mark.parametrize(
    "expr,text,expected",
    [
        ("1a foo\n2d", "x\ny\n", "x\nfoo\n"),
        ("1a foo; 2d", "x\ny\n", "x\nfoo; 2d\ny\n"),
        ("a int x = 1; echo bar", "x\n", "x\nint x = 1; echo bar\n"),
        ("1d\n$a foo   ", "x\ny\n", "y\nfoo   \n"),
    ],
)
async def test_text_runs_to_newline(expr, text, expected):
    assert (await _sed(expr, text)) == expected


@pytest.mark.parametrize(
    "expr,text,expected",
    [
        ("a one\\/two\\", "x\n", "x\none\\/two\n"),
        ("a\\", "x\ny\n", "x\ny\n"),
        ("c\\", "x\ny\n", ""),
    ],
)
async def test_text_undecoded_when_script_ends_on_backslash(
    expr, text, expected
):
    assert (await _sed(expr, text)) == expected


async def test_text_refuses_missing_text_and_open_block():
    with pytest.raises(
        ValueError, match="expected \\\\ after `a', `c' or `i'"
    ):
        (await _sed("a", "x\n"))
    with pytest.raises(ValueError, match="unmatched `{'"):
        (await _sed("1{a foo;}", "x\ny\n"))
    assert (await _sed("1{a foo\n}", "x\ny\n")) == "x\nfoo\ny\n"


@pytest.mark.parametrize(
    "script,text,expected",
    [
        ("2b\ns/./X/", "a\nb\nc\nd\n", "X\nb\nX\nX\n"),
        ("1b\n$!d", "a\nb\nc\nd\n", "a\nd\n"),
        ("s/a/A/\nt\ns/./X/", "a\nb\n", "A\nX\n"),
        ("1b done\ns/./X/\n:done\ns/$/!/", "a\nb\n", "a!\nX!\n"),
    ],
)
async def test_branch_and_label_end_at_newline(script, text, expected):
    assert (await _sed(script, text)) == expected


@pytest.mark.parametrize(
    "expr,text,expected",
    [
        ("s/.*/\\U&/", "hello world\n", "HELLO WORLD\n"),
        ("s/\\w\\+/\\u&/g", "hello world\n", "Hello World\n"),
        ("s/\\(o\\) \\(w\\)/\\U\\1\\E \\2/", "hello world\n", "hellO world\n"),
        ("s/.*/\\u\\L&/", "hELLO\n", "hello\n"),
        ("s/.*/\\L\\u&/", "hELLO\n", "Hello\n"),
        ("s/\\(x*\\)\\(a\\)/\\u\\1\\2/", "ab\n", "Ab\n"),
        ("s/abc/\\u\\lX/", "abc\n", "x\n"),
        ("s/\\(x*\\)a/\\u\\1\\Lz/", "a\n", "z\n"),
        ("s/\\(x*\\)a/\\l\\1\\UZz/", "a\n", "ZZ\n"),
        ("s/\\(x*\\)a\\(b\\)/\\u\\1\\E\\2/", "ab\n", "b\n"),
        ("s/\\(x*\\)a/\\u\\1\\l\\1\\Uq/", "ab\n", "Qb\n"),
        ("s/\\(x*\\)\\(y*\\)\\(a\\)/\\u\\1\\2\\3/", "ab\n", "ab\n"),
        ("s/.*/\\U&/", "a\u00e9\n", byte_view("A\u00e9\n")),
    ],
)
async def test_s_case_conversion(expr, text, expected):
    assert (await _sed(expr, text)) == expected


async def test_l_escapes_and_octal():
    assert list_line("a\tb\\c\x01", 70) == "a\\tb\\\\c\\001$\n"
    assert (
        list_line("x\x7f\x1b\r\f\v\b\x07", 70)
        == "x\\177\\033\\r\\f\\v\\b\\a$\n"
    )
    assert list_line(byte_view("caf\u00e9"), 70) == "caf\\303\\251$\n"
    assert list_line(byte_view(b"\xff"), 70) == "\\377$\n"


async def test_l_folds_at_69_and_a_backslash():
    assert list_line("0" * 69, 70) == "0" * 69 + "$\n"
    assert list_line("0" * 70, 70) == "0" * 69 + "\\\n0$\n"
    assert list_line("aaa\tb", 5) == "aaa\\\n\\tb$\n"
    assert list_line("abc", 0) == "abc$\n"
    assert list_line("ab", 1) == "\\\na\\\nb$\n"


async def test_l_width_from_command_option_and_default():
    assert (await _run("l 5", "abcdefgh\n", suppress=True))[
        0
    ] == "abcd\\\nefgh$\n"
    assert (await _run("l", "abcdefgh\n", suppress=True, line_length=5))[
        0
    ] == "abcd\\\nefgh$\n"
    assert (await _run("l;l 0", "abcdefgh\n", suppress=True, line_length=5))[
        0
    ] == "abcd\\\nefgh$\nabcdefgh$\n"
    assert (await _run("N;l", "a\nb\n", suppress=True))[0] == "a\\nb$\n"
    assert (await _sed("l", "abc")) == "abc$\nabc"


async def test_equals_n_and_N():
    assert (await _run("$=", "a\nb\nc\n", suppress=True))[0] == "3\n"
    assert (await _run("p;=", "a\nb", suppress=True))[0] == "a\n1\nb\n2\n"
    assert (await _run("n;p", "a\nb\nc\n", suppress=True))[0] == "b\n"
    assert (await _sed("n;d", "a\nb\nc\n")) == "a\nc\n"
    assert (await _sed("n", "a\n")) == "a\n"
    assert (await _run("n;p", "a\n", suppress=True))[0] == ""
    assert (await _sed("n;a X", "a\nb\nc\n")) == "a\nb\nX\nc\n"
    assert (await _run(["a X", "N"], "a\nb\n"))[0] == "X\na\nb\n"
    assert (await _sed("s/a/X/;n;T;s/$/!/", "a\nb\n")) == "X\nb\n"
    assert (await _sed("N", "a\nb\nc\n")) == "a\nb\nc\n"
    assert (await _run("N;p", "a\nb\nc\n", suppress=True))[0] == "a\nb\n"
    assert (await _sed("$!N;P;D", "a\nb\nc\n")) == "a\nb\nc\n"


async def test_q_Q_T_z():
    out, _, code, _ = await _run(["1a X", "1q5"], "a\nb\n")
    assert (out, code) == ("a\nX\n", 5)
    assert (await _run("2q 300", "a\nb\nc\n"))[2] == 44
    out, _, code, _ = await _run(["1a X", "1Q7"], "a\nb\n")
    assert (out, code) == ("", 7)
    assert (await _sed("s/a/A/;T;s/$/!/", "a\nb\nc\n")) == "A!\nb\nc\n"
    assert (await _sed("z;s/^$/E/", "a\nb\n")) == "E\nE\n"


_FILES = {"/r": SedFileText("R1\nR2\n"), "/nonl": SedFileText("x")}


async def test_r_queues_the_file():
    assert (await _run("r /r", "a\nb\n", files=_FILES))[
        0
    ] == "a\nR1\nR2\nb\nR1\nR2\n"
    assert (await _run(["1r /r", "1a X"], "a\nb\n", files=_FILES))[
        0
    ] == "a\nR1\nR2\nX\nb\n"
    assert (await _run(["1r /r", "1d"], "a\nb\n", files=_FILES))[
        0
    ] == "R1\nR2\nb\n"
    assert (await _run("r /nonl", "a\nb\n", files=_FILES))[0] == "a\nxb\nx"
    assert (await _run("0r /r", "a\nb\n", files=_FILES))[0] == "R1\nR2\na\nb\n"
    assert (await _run("1r /nope", "a\nb\n", files=_FILES))[0] == "a\nb\n"
    assert (await _run("R /nope", "a\nb\n", files=_FILES))[0] == "a\nb\n"


async def test_r_of_a_directory_is_a_read_error():
    err = "sed: read error on /d: Is a directory\n"
    out, stderr, code, _ = await _run(
        "r /d", "a\nb\n", files={"/d": SedFileError(err)}
    )
    assert (out, stderr, code) == ("a\n", err, 4)


async def test_R_reads_one_line_per_run():
    assert (await _run("R /r", "a\nb\nc\n", files=_FILES))[
        0
    ] == "a\nR1\nb\nR2\nc\n"
    assert (await _run(["R /r", "R /r"], "a\nb\n", files=_FILES))[
        0
    ] == "a\nR1\nR2\nb\n"
    inputs = [SedInput("f", "a\n"), SedInput("f", "a\n")]
    assert (await _run("R /r", inputs, files=_FILES))[0] == "a\nR1\na\nR2\n"
    assert (await _run("R /r", inputs, files=_FILES, separate=True))[
        0
    ] == "a\nR1\na\nR1\n"


async def test_w_W_and_s_w():
    assert (await _run("w /o", "a\nb", suppress=True))[3]["/o"] == "a\nb"
    assert (await _run("N;W /o", "a\nb\nc\n", suppress=True))[3]["/o"] == "a\n"
    assert (await _run("s/a/X/w /o", "a\nb\n"))[3]["/o"] == "X\n"
    assert (await _run(["1w /o", "2w /o"], "a\nb\n", suppress=True))[3][
        "/o"
    ] == "a\nb\n"


async def test_special_files():
    assert (await _sed("w /dev/stdout", "a\nb\n")) == "a\na\nb\nb\n"
    assert (await _sed("w /dev/stdout", "a\nb")) == "a\na\nbb"
    assert (await _sed("s/a/X/w /dev/stdout", "a\nb\n")) == "X\nX\nb\n"
    out, err, _, _ = await _run("1w /dev/stderr", "a\nb\n", suppress=True)
    assert (out, err) == ("", "a\n")


async def test_F_prints_the_name():
    assert (await _sed("F", "a\n")) == "-\na\n"
    inputs = [SedInput("/f1", "a\n"), SedInput("f2", "b\n")]
    assert (await _run("F", inputs))[0] == "/f1\na\nf2\nb\n"


async def test_gnu_addresses():
    assert (await _sed("1~2!d", "a\nb\nc\n")) == "a\nc\n"
    assert (await _run("2,+1p", "a\nb\nc\n", suppress=True))[0] == "b\nc\n"
    assert (await _run("2,~4p", "a\nb\nc\nd\ne\n", suppress=True))[
        0
    ] == "b\nc\nd\n"
    assert (await _run("0,/a/p", "a\nb\n", suppress=True))[0] == "a\n"
    assert (await _run("1,/a/p", "a\nb\n", suppress=True))[0] == "a\nb\n"
    assert (await _run("/a/,/a/p", "a\nb\na\nc\n", suppress=True))[
        0
    ] == "a\nb\na\n"
    assert (await _run("2,1p", "a\nb\nc\n", suppress=True))[0] == "b\n"
    assert (await _run("/b/,1p", "a\nb\nc\n", suppress=True))[0] == "b\n"


async def test_c_on_a_range():
    assert (await _sed("2,3cX", "a\nb\nc\nd\n")) == "a\nX\nd\n"
    assert (await _sed("1,/x/c\\\nX", "a\nb\n")) == ""
    assert (await _sed("2,3!cX", "a\nb\nc\nd\n")) == "X\nb\nc\nX\n"


async def test_empty_regex_is_the_last_one():
    assert (await _run("/b/{//p}", "abc\n", suppress=True))[0] == "abc\n"
    assert (await _sed("s/b/X/;s//Y/", "abc\n")) == "aXc\n"
    _, err, code, _ = await _run("//p", "abc\n")
    assert err == (
        "sed: -e expression #1, char 0: no previous regular expression\n"
    )
    assert code == 1


async def test_I_and_M():
    assert (await _run("/A/Ip", "a\nb\n", suppress=True))[0] == "a\n"
    assert (await _sed("N;s/^b/>/M", "a\nb\n")) == "a\n>\n"
    assert (await _sed("N;s/^b/>/", "a\nb\n")) == "a\nb\n"


async def test_missing_newline_goes_out_before_anything_else():
    assert (await _sed("p", "a")) == "a\na"
    assert (await _sed("a X", "a\nb")) == "a\nX\nb\nX\n"
    assert (await _sed("i X", "a")) == "X\na"


async def test_last_line_across_files_and_separate():
    inputs = [
        SedInput("f", "one\ntwo\n"),
        SedInput("g", "x\ny\n"),
        SedInput("e", ""),
    ]
    assert (await _run("$=", inputs, suppress=True))[0] == "4\n"
    assert (await _run("$=", inputs, suppress=True, separate=True))[
        0
    ] == "2\n2\n"
    assert (await _run("1h;2G", inputs[:2], separate=True))[
        0
    ] == "one\ntwo\none\nx\ny\nx\n"


async def _missing():
    raise FileNotFoundError("nope")
    yield b""


async def test_q_never_opens_a_later_operand_and_a_failed_one_outranks_it():
    out, _, code, _ = await _run(
        "2{p;q}",
        [SedInput("f", "one\ntwo\n"), SedInput("nope", source=_missing())],
        suppress=True,
    )
    assert (out, code) == ("two\n", 0)
    _, err, code, _ = await _run(
        "Q3", [SedInput("nope", source=_missing()), SedInput("f", "one\n")]
    )
    assert (err, code) == (
        "sed: can't read nope: No such file or directory\n",
        2,
    )


async def test_L_is_an_internal_error_when_it_runs():
    _, err, code, _ = await _run("L", "a\n")
    assert (err, code) == ("sed: INTERNAL ERROR: Bad cmd L\n", 4)


async def _sed_e(expr: str, text: str) -> str:
    return (await _run(expr, text, extended=True))[0]


async def test_regex_escapes_are_converted_before_regcomp():
    assert (await _sed("s/\\d065/X/", "A\n")) == "X\n"
    assert await _sed_e("s/\\d065/X/", "A\n") == "X\n"
    assert (await _sed("s/\\o101/X/", "A\n")) == "X\n"
    assert await _sed_e("s/\\x41/X/", "x41 A\n") == "x41 X\n"
    assert await _sed_e("s/\\t/X/", "a\tb t\n") == "aXb t\n"
    assert (await _sed("s/\\cA/X/", "a\x01b\n")) == "aXb\n"
    assert (await _sed("N;s/[\\n]/X/", "a\nb\n")) == "aXb\n"
    assert (await _sed("s/[\\t]/X/", "a\tb\n")) == "aXb\n"


async def test_regex_d_without_digits_and_escaped_syntax():
    assert await _sed_e("s/\\d/X/", "d 7\n") == "X 7\n"
    assert await _sed_e("s/\\d+/<&>/g", "abc 123 x45\n") == "abc 123 x45\n"
    assert (await _sed("s/a\\x2eb/X/g", "a.b axb\n")) == "X X\n"
    assert (await _sed("s/a\\x2ab/X/g", "a*b aab\n")) == "a*X X\n"


async def test_regex_gnu_operators_and_posix_brackets():
    assert await _sed_e("s/\\<w/X/g", "word sword\n") == "Xord sword\n"
    assert await _sed_e("s/\\w+/X/g", "a_b c\n") == "X X\n"
    assert await _sed_e("s/a\\+/X/", "a+b aab\n") == "Xb aab\n"
    assert (await _sed("s/a\\+/X/", "a+b aab\n")) == "X+b aab\n"
    assert (await _sed("s/a|b/X/", "a|b\n")) == "X\n"
    assert await _sed_e("s/a|b/X/g", "a|b\n") == "X|X\n"
    assert (await _sed("s/[\\.]/X/g", "a.b\\\n")) == "aXbX\n"
    assert (await _sed("s/*a/x/", "a\n")) == "a\n"
    assert (await _sed("s/a{x}/y/", "a{x}\n")) == "y\n"
    assert await _sed_e("s/a$b/X/", "ab\n") == "ab\n"
    assert (await _sed("s/a^b/X/", "a^b\n")) == "X\n"


async def test_dot_matches_newline_except_under_M():
    assert (await _sed("N;s/a.b/X/", "a\nb\n")) == "X\n"
    assert (await _sed("N;s/a[^x]b/X/", "a\nb\n")) == "X\n"
    assert (await _sed("N;s/a.b/X/M", "a\nb\n")) == "a\nb\n"
    assert (await _sed("N;s/a$/X/M", "a\nb\n")) == "X\nb\n"
    assert (await _sed("N;s/a$/X/", "a\nb\n")) == "a\nb\n"
    assert (await _sed("N;s/^/X/Mg", "a\nb\n")) == "Xa\nXb\n"


async def test_r_files_read_anew_after_set_files_R_once():
    machine = SedMachine(
        compile_script(
            [SedScriptPiece("expr", "1r /r"), SedScriptPiece("expr", "1R /q")]
        ),
        SedRunOptions(
            separate=True,
            files={"/r": SedFileText("old\n")},
            reader_files={"/q": SedFileText("Q1\nQ2\n")},
        ),
    )
    assert (
        "".join(
            [
                chunk
                async for chunk in machine.process(
                    [SedInput("a", "a\n")], False
                )
            ]
        )
        == "a\nold\nQ1\n"
    )
    machine.set_files({"/r": SedFileText("new\n")})
    assert (
        "".join(
            [
                chunk
                async for chunk in machine.process(
                    [SedInput("b", "b\n")], False
                )
            ]
        )
        == "b\nnew\nQ1\n"
    )
