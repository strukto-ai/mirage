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


def _run(
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
    machine.process(
        [SedInput("-", byte_view(inputs))]
        if isinstance(inputs, str)
        else inputs,
        True,
    )
    wfiles = {
        name: "".join(out.chunks) for name, out in machine.wfiles.items()
    }
    return (
        "".join(machine.stdout.chunks),
        machine.stderr(),
        machine.exit_code(),
        wfiles,
    )


def _sed(expr: str, text: str, suppress: bool = False) -> str:
    return _run(expr, text, suppress=suppress)[0]


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
def test_text_drops_backslash_before_ordinary_char(expr, text, expected):
    assert _sed(expr, text) == expected


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
def test_text_decodes_escapes(expr, expected):
    assert _sed(expr, "x\n") == expected


def test_text_decodes_numeric_and_control_escapes():
    assert (
        _sed("a [\\d065][\\x41][\\o101][\\x4][\\xZ][\\d300]", "x\n")
        == "x\n[A][A][A][\x04][xZ][,]\n"
    )
    assert (
        _sed("a [\\cA][\\ca][\\c?][\\c\\\\]", "x\n")
        == "x\n[\x01][\x01][\x7f][\x1c]\n"
    )
    with pytest.raises(
        ValueError, match=r"recursive escaping after \\c not allowed"
    ):
        _sed("a [\\c\\d]", "x\n")


def test_text_numeric_escapes_above_ascii_are_raw_bytes():
    out = _sed("a [\\xff][\\d200][\\o377][\\x80][\\xc3\\xa9][\\o400]", "x\n")
    assert from_byte_view(out) == (
        b"x\n[\xff][\xc8][\xff][\x80][\xc3\xa9][\x00]\n"
    )


def test_text_final_c_escape_takes_closing_newline():
    assert _sed("a foo\\c", "x\ny\n") == "x\nfooJy\nfooJ"
    assert _sed("i foo\\c", "x\n") == "foo\nx\n"


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
def test_text_leading_blanks(expr, expected):
    assert _sed(expr, "x\n") == expected


@pytest.mark.parametrize(
    "expr,expected",
    [
        ("a\\\n  l1\\\n  l2", "x\n  l1\n  l2\n"),
        ("i\\\nl1\\\nl2", "l1\nl2\nx\n"),
        ("a foo\\\nbar", "x\nfoo\nbar\n"),
    ],
)
def test_text_classic_form_and_continued_lines(expr, expected):
    assert _sed(expr, "x\n") == expected


@pytest.mark.parametrize(
    "expr,text,expected",
    [
        ("1a foo\n2d", "x\ny\n", "x\nfoo\n"),
        ("1a foo; 2d", "x\ny\n", "x\nfoo; 2d\ny\n"),
        ("a int x = 1; echo bar", "x\n", "x\nint x = 1; echo bar\n"),
        ("1d\n$a foo   ", "x\ny\n", "y\nfoo   \n"),
    ],
)
def test_text_runs_to_newline(expr, text, expected):
    assert _sed(expr, text) == expected


@pytest.mark.parametrize(
    "expr,text,expected",
    [
        ("a one\\/two\\", "x\n", "x\none\\/two\n"),
        ("a\\", "x\ny\n", "x\ny\n"),
        ("c\\", "x\ny\n", ""),
    ],
)
def test_text_undecoded_when_script_ends_on_backslash(expr, text, expected):
    assert _sed(expr, text) == expected


def test_text_refuses_missing_text_and_open_block():
    with pytest.raises(
        ValueError, match="expected \\\\ after `a', `c' or `i'"
    ):
        _sed("a", "x\n")
    with pytest.raises(ValueError, match="unmatched `{'"):
        _sed("1{a foo;}", "x\ny\n")
    assert _sed("1{a foo\n}", "x\ny\n") == "x\nfoo\ny\n"


@pytest.mark.parametrize(
    "script,text,expected",
    [
        ("2b\ns/./X/", "a\nb\nc\nd\n", "X\nb\nX\nX\n"),
        ("1b\n$!d", "a\nb\nc\nd\n", "a\nd\n"),
        ("s/a/A/\nt\ns/./X/", "a\nb\n", "A\nX\n"),
        ("1b done\ns/./X/\n:done\ns/$/!/", "a\nb\n", "a!\nX!\n"),
    ],
)
def test_branch_and_label_end_at_newline(script, text, expected):
    assert _sed(script, text) == expected


def test_l_escapes_and_octal():
    assert list_line("a\tb\\c\x01", 70) == "a\\tb\\\\c\\001$\n"
    assert (
        list_line("x\x7f\x1b\r\f\v\b\x07", 70)
        == "x\\177\\033\\r\\f\\v\\b\\a$\n"
    )
    assert list_line(byte_view("caf\u00e9"), 70) == "caf\\303\\251$\n"
    assert list_line(byte_view(b"\xff"), 70) == "\\377$\n"


def test_l_folds_at_69_and_a_backslash():
    assert list_line("0" * 69, 70) == "0" * 69 + "$\n"
    assert list_line("0" * 70, 70) == "0" * 69 + "\\\n0$\n"
    assert list_line("aaa\tb", 5) == "aaa\\\n\\tb$\n"
    assert list_line("abc", 0) == "abc$\n"
    assert list_line("ab", 1) == "\\\na\\\nb$\n"


def test_l_width_from_command_option_and_default():
    assert _run("l 5", "abcdefgh\n", suppress=True)[0] == "abcd\\\nefgh$\n"
    assert (
        _run("l", "abcdefgh\n", suppress=True, line_length=5)[0]
        == "abcd\\\nefgh$\n"
    )
    assert (
        _run("l;l 0", "abcdefgh\n", suppress=True, line_length=5)[0]
        == "abcd\\\nefgh$\nabcdefgh$\n"
    )
    assert _run("N;l", "a\nb\n", suppress=True)[0] == "a\\nb$\n"
    assert _sed("l", "abc") == "abc$\nabc"


def test_equals_n_and_N():
    assert _run("$=", "a\nb\nc\n", suppress=True)[0] == "3\n"
    assert _run("p;=", "a\nb", suppress=True)[0] == "a\n1\nb\n2\n"
    assert _run("n;p", "a\nb\nc\n", suppress=True)[0] == "b\n"
    assert _sed("n;d", "a\nb\nc\n") == "a\nc\n"
    assert _sed("n", "a\n") == "a\n"
    assert _run("n;p", "a\n", suppress=True)[0] == ""
    assert _sed("n;a X", "a\nb\nc\n") == "a\nb\nX\nc\n"
    assert _run(["a X", "N"], "a\nb\n")[0] == "X\na\nb\n"
    assert _sed("s/a/X/;n;T;s/$/!/", "a\nb\n") == "X\nb\n"
    assert _sed("N", "a\nb\nc\n") == "a\nb\nc\n"
    assert _run("N;p", "a\nb\nc\n", suppress=True)[0] == "a\nb\n"
    assert _sed("$!N;P;D", "a\nb\nc\n") == "a\nb\nc\n"


def test_q_Q_T_z():
    out, _, code, _ = _run(["1a X", "1q5"], "a\nb\n")
    assert (out, code) == ("a\nX\n", 5)
    assert _run("2q 300", "a\nb\nc\n")[2] == 44
    out, _, code, _ = _run(["1a X", "1Q7"], "a\nb\n")
    assert (out, code) == ("", 7)
    assert _sed("s/a/A/;T;s/$/!/", "a\nb\nc\n") == "A!\nb\nc\n"
    assert _sed("z;s/^$/E/", "a\nb\n") == "E\nE\n"


_FILES = {"/r": SedFileText("R1\nR2\n"), "/nonl": SedFileText("x")}


def test_r_queues_the_file():
    assert _run("r /r", "a\nb\n", files=_FILES)[0] == "a\nR1\nR2\nb\nR1\nR2\n"
    assert (
        _run(["1r /r", "1a X"], "a\nb\n", files=_FILES)[0]
        == "a\nR1\nR2\nX\nb\n"
    )
    assert _run(["1r /r", "1d"], "a\nb\n", files=_FILES)[0] == "R1\nR2\nb\n"
    assert _run("r /nonl", "a\nb\n", files=_FILES)[0] == "a\nxb\nx"
    assert _run("0r /r", "a\nb\n", files=_FILES)[0] == "R1\nR2\na\nb\n"
    assert _run("1r /nope", "a\nb\n", files=_FILES)[0] == "a\nb\n"
    assert _run("R /nope", "a\nb\n", files=_FILES)[0] == "a\nb\n"


def test_r_of_a_directory_is_a_read_error():
    err = "sed: read error on /d: Is a directory\n"
    out, stderr, code, _ = _run(
        "r /d", "a\nb\n", files={"/d": SedFileError(err)}
    )
    assert (out, stderr, code) == ("a\n", err, 4)


def test_R_reads_one_line_per_run():
    assert _run("R /r", "a\nb\nc\n", files=_FILES)[0] == "a\nR1\nb\nR2\nc\n"
    assert (
        _run(["R /r", "R /r"], "a\nb\n", files=_FILES)[0] == "a\nR1\nR2\nb\n"
    )
    inputs = [SedInput("f", "a\n"), SedInput("f", "a\n")]
    assert _run("R /r", inputs, files=_FILES)[0] == "a\nR1\na\nR2\n"
    assert (
        _run("R /r", inputs, files=_FILES, separate=True)[0]
        == "a\nR1\na\nR1\n"
    )


def test_w_W_and_s_w():
    assert _run("w /o", "a\nb", suppress=True)[3]["/o"] == "a\nb"
    assert _run("N;W /o", "a\nb\nc\n", suppress=True)[3]["/o"] == "a\n"
    assert _run("s/a/X/w /o", "a\nb\n")[3]["/o"] == "X\n"
    assert (
        _run(["1w /o", "2w /o"], "a\nb\n", suppress=True)[3]["/o"] == "a\nb\n"
    )


def test_special_files():
    assert _sed("w /dev/stdout", "a\nb\n") == "a\na\nb\nb\n"
    assert _sed("w /dev/stdout", "a\nb") == "a\na\nbb"
    assert _sed("s/a/X/w /dev/stdout", "a\nb\n") == "X\nX\nb\n"
    out, err, _, _ = _run("1w /dev/stderr", "a\nb\n", suppress=True)
    assert (out, err) == ("", "a\n")


def test_F_prints_the_name():
    assert _sed("F", "a\n") == "-\na\n"
    inputs = [SedInput("/f1", "a\n"), SedInput("f2", "b\n")]
    assert _run("F", inputs)[0] == "/f1\na\nf2\nb\n"


def test_gnu_addresses():
    assert _sed("1~2!d", "a\nb\nc\n") == "a\nc\n"
    assert _run("2,+1p", "a\nb\nc\n", suppress=True)[0] == "b\nc\n"
    assert _run("2,~4p", "a\nb\nc\nd\ne\n", suppress=True)[0] == "b\nc\nd\n"
    assert _run("0,/a/p", "a\nb\n", suppress=True)[0] == "a\n"
    assert _run("1,/a/p", "a\nb\n", suppress=True)[0] == "a\nb\n"
    assert _run("/a/,/a/p", "a\nb\na\nc\n", suppress=True)[0] == "a\nb\na\n"
    assert _run("2,1p", "a\nb\nc\n", suppress=True)[0] == "b\n"
    assert _run("/b/,1p", "a\nb\nc\n", suppress=True)[0] == "b\n"


def test_c_on_a_range():
    assert _sed("2,3cX", "a\nb\nc\nd\n") == "a\nX\nd\n"
    assert _sed("1,/x/c\\\nX", "a\nb\n") == ""
    assert _sed("2,3!cX", "a\nb\nc\nd\n") == "X\nb\nc\nX\n"


def test_empty_regex_is_the_last_one():
    assert _run("/b/{//p}", "abc\n", suppress=True)[0] == "abc\n"
    assert _sed("s/b/X/;s//Y/", "abc\n") == "aXc\n"
    _, err, code, _ = _run("//p", "abc\n")
    assert err == (
        "sed: -e expression #1, char 0: no previous regular expression\n"
    )
    assert code == 1


def test_I_and_M():
    assert _run("/A/Ip", "a\nb\n", suppress=True)[0] == "a\n"
    assert _sed("N;s/^b/>/M", "a\nb\n") == "a\n>\n"
    assert _sed("N;s/^b/>/", "a\nb\n") == "a\nb\n"


def test_missing_newline_goes_out_before_anything_else():
    assert _sed("p", "a") == "a\na"
    assert _sed("a X", "a\nb") == "a\nX\nb\nX\n"
    assert _sed("i X", "a") == "X\na"


def test_last_line_across_files_and_separate():
    inputs = [
        SedInput("f", "one\ntwo\n"),
        SedInput("g", "x\ny\n"),
        SedInput("e", ""),
    ]
    assert _run("$=", inputs, suppress=True)[0] == "4\n"
    assert _run("$=", inputs, suppress=True, separate=True)[0] == "2\n2\n"
    assert (
        _run("1h;2G", inputs[:2], separate=True)[0]
        == "one\ntwo\none\nx\ny\nx\n"
    )


def test_operand_errors():
    missing = SedInput("nope", error="sed: can't read nope: x\n", code=2)
    out, _, code, _ = _run(
        "p",
        [SedInput("f", "a\n"), missing, SedInput("g", "b\n")],
        suppress=True,
    )
    assert (out, code) == ("a\nb\n", 2)
    out, _, code, _ = _run(
        "2{p;q}", [SedInput("f", "one\ntwo\n"), missing], suppress=True
    )
    assert (out, code) == ("two\n", 0)
    assert _run("Q3", [missing, SedInput("f", "one\n")])[2] == 2
    folder = SedInput(
        "d", error="sed: read error on d: x\n", code=4, fatal=True
    )
    out, _, code, _ = _run(
        "p",
        [SedInput("f", "a\n"), folder, SedInput("g", "b\n")],
        suppress=True,
    )
    assert (out, code) == ("a\n", 4)


def test_L_is_an_internal_error_when_it_runs():
    _, err, code, _ = _run("L", "a\n")
    assert (err, code) == ("sed: INTERNAL ERROR: Bad cmd L\n", 4)


def _sed_e(expr: str, text: str) -> str:
    return _run(expr, text, extended=True)[0]


def test_regex_escapes_are_converted_before_regcomp():
    assert _sed("s/\\d065/X/", "A\n") == "X\n"
    assert _sed_e("s/\\d065/X/", "A\n") == "X\n"
    assert _sed("s/\\o101/X/", "A\n") == "X\n"
    assert _sed_e("s/\\x41/X/", "x41 A\n") == "x41 X\n"
    assert _sed_e("s/\\t/X/", "a\tb t\n") == "aXb t\n"
    assert _sed("s/\\cA/X/", "a\x01b\n") == "aXb\n"
    assert _sed("N;s/[\\n]/X/", "a\nb\n") == "aXb\n"
    assert _sed("s/[\\t]/X/", "a\tb\n") == "aXb\n"


def test_regex_d_without_digits_and_escaped_syntax():
    assert _sed_e("s/\\d/X/", "d 7\n") == "X 7\n"
    assert _sed_e("s/\\d+/<&>/g", "abc 123 x45\n") == "abc 123 x45\n"
    assert _sed("s/a\\x2eb/X/g", "a.b axb\n") == "X X\n"
    assert _sed("s/a\\x2ab/X/g", "a*b aab\n") == "a*X X\n"


def test_regex_gnu_operators_and_posix_brackets():
    assert _sed_e("s/\\<w/X/g", "word sword\n") == "Xord sword\n"
    assert _sed_e("s/\\w+/X/g", "a_b c\n") == "X X\n"
    assert _sed_e("s/a\\+/X/", "a+b aab\n") == "Xb aab\n"
    assert _sed("s/a\\+/X/", "a+b aab\n") == "X+b aab\n"
    assert _sed("s/a|b/X/", "a|b\n") == "X\n"
    assert _sed_e("s/a|b/X/g", "a|b\n") == "X|X\n"
    assert _sed("s/[\\.]/X/g", "a.b\\\n") == "aXbX\n"
    assert _sed("s/*a/x/", "a\n") == "a\n"
    assert _sed("s/a{x}/y/", "a{x}\n") == "y\n"
    assert _sed_e("s/a$b/X/", "ab\n") == "ab\n"
    assert _sed("s/a^b/X/", "a^b\n") == "X\n"


def test_dot_matches_newline_except_under_M():
    assert _sed("N;s/a.b/X/", "a\nb\n") == "X\n"
    assert _sed("N;s/a[^x]b/X/", "a\nb\n") == "X\n"
    assert _sed("N;s/a.b/X/M", "a\nb\n") == "a\nb\n"
    assert _sed("N;s/a$/X/M", "a\nb\n") == "X\nb\n"
    assert _sed("N;s/a$/X/", "a\nb\n") == "a\nb\n"
    assert _sed("N;s/^/X/Mg", "a\nb\n") == "Xa\nXb\n"


def test_lookahead_skips_a_directory_but_reading_on_panics():
    folder = SedInput(
        "d", error="sed: read error on d: Is a directory\n", code=4, fatal=True
    )
    one = SedInput("f", "one\ntwo\n")
    out, _, code, _ = _run("$p", [one, folder], suppress=True)
    assert (out, code) == ("two\n", 0)
    out, _, code, _ = _run(
        "$p", [one, folder, SedInput("g", "x\n")], suppress=True
    )
    assert (out, code) == ("x\n", 0)
    out, err, code, _ = _run("n", [one, folder])
    assert (out, err, code) == ("one\ntwo\n", folder.error, 4)
    out, _, code, _ = _run("$p", [one, folder], suppress=True, separate=True)
    assert (out, code) == ("two\n", 4)


def test_r_files_read_anew_after_set_files_R_once():
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
    assert machine.process([SedInput("a", "a\n")], False) == "a\nold\nQ1\n"
    machine.set_files({"/r": SedFileText("new\n")})
    assert machine.process([SedInput("b", "b\n")], False) == "b\nnew\nQ1\n"
