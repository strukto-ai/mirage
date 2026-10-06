import pytest

from mirage.commands.builtin.sed_script import (
    SedAddr,
    SedError,
    SedScriptPiece,
    compile_script,
)


def _compile(*exprs: str):
    return compile_script([SedScriptPiece("expr", text) for text in exprs])


def _refusal(pieces: list[SedScriptPiece], extended: bool = False) -> SedError:
    with pytest.raises(SedError) as info:
        compile_script(pieces, extended)
    return info.value


def _error(*exprs: str) -> str:
    return str(_refusal([SedScriptPiece("expr", text) for text in exprs]))


def _cmds(*exprs: str) -> str:
    return "".join(c.cmd for c in _compile(*exprs).commands)


@pytest.mark.parametrize(
    "expr",
    [
        "2 d",
        "2,3 p",
        "/b/ p",
        "2 s/b/X/",
        "2, 3p",
        "2 , 3 p",
        "2 !d",
        "2 ! d",
        "1 ~ 2 p",
        "/B/ I p",
    ],
)
def test_blanks_after_address_comma_and_bang(expr):
    [cmd] = _compile(expr).commands
    assert cmd.a1 is not None
    assert cmd.cmd in "dps"


def test_blanks_and_semicolons_between_commands():
    assert _cmds(" ; ;2p ; ; 3p") == "pp"
    assert _cmds("2,3 { p }") == "{p}"
    assert _cmds("2{ p ; }") == "{p}"
    assert _cmds("{p};{p}") == "{p}{p}"


def test_s_flags_and_y_take_blanks_and_nothing_else():
    assert _cmds("s/b/X/ g") == "s"
    assert _cmds("s/b/X/ ; p") == "sp"
    assert _cmds("s/b/X/g p") == "s"
    assert _cmds("y/b/X/ ;p") == "yp"
    assert _error("y/b/X/p") == (
        "sed: -e expression #1, char 7: extra characters after command"
    )
    assert _error("p x") == (
        "sed: -e expression #1, char 3: extra characters after command"
    )


def test_comments():
    assert _cmds("2p # comment") == "p"
    assert _cmds("2d#x") == "d"
    assert _cmds("p;# c\np") == "pp"


def test_labels_end_at_blank_semicolon_brace_or_hash():
    program = _compile(":a p")
    assert [(c.cmd, c.label) for c in program.commands] == [
        (":", "a"),
        ("p", ""),
    ]
    assert _cmds("2b x ; p ; :x") == "bp:"
    assert _cmds("2{bx};p;:x") == "{b}p:"


def test_file_names_run_to_the_end_of_the_line():
    assert _compile("1r /data/r.txt ;p").commands[0].fname == "/data/r.txt ;p"
    assert _compile("2r/data/r").commands[0].fname == "/data/r"
    assert _compile("w /o ").wfiles == ["/o "]


def test_l_q_Q_numbers():
    assert _compile("l 5").commands[0].int_arg == 5
    assert _compile("l5").commands[0].int_arg == 5
    assert _compile("l").commands[0].int_arg == -1
    assert _compile("2 q 5").commands[0].int_arg == 5
    assert _error("2q x") == (
        "sed: -e expression #1, char 4: extra characters after command"
    )


def test_hash_n_and_v():
    assert _compile("#n\np").no_default_output
    assert _compile("#nfoo").no_default_output
    assert not _compile(" #n").no_default_output
    assert not _compile("p", "#n").no_default_output
    assert _cmds("v;p") == "p"
    assert _cmds("v 4.2;p") == "p"
    assert _error("v 9.0") == (
        "sed: -e expression #1, char 5: expected newer version of sed"
    )


@pytest.mark.parametrize(
    "expr,why",
    [
        ("2!!d", "char 3: multiple `!'s"),
        ("2! !d", "char 4: multiple `!'s"),
        ("2}", "char 2: unexpected `}'"),
        ("{p", "char 0: unmatched `{'"),
        ("2", "char 1: missing command"),
        ("2 ", "char 2: missing command"),
        ("2!", "char 2: missing command"),
        ("k", "char 1: unknown command: `k'"),
        ("2 k", "char 3: unknown command: `k'"),
        (",p", "char 1: unknown command: `,'"),
        ("1,p", "char 3: unexpected `,'"),
        ("0p", "char 2: invalid usage of line address 0"),
        ("0,2p", "char 4: invalid usage of line address 0"),
        ("+1p", "char 2: invalid usage of +N or ~N as first address"),
        ("s/a/b", "char 5: unterminated `s' command"),
        ("s/a/b/k", "char 7: unknown option to `s'"),
        ("/a", "char 2: unterminated address regex"),
        (":", 'char 1: ":" lacks a label'),
        ("1:a", "char 2: : doesn't want any addresses"),
        ("1#x", "char 2: comments don't accept any addresses"),
        ("y/ab/c/", "char 7: strings for `y' command are different lengths"),
        ("y/ab/cd", "char 7: unterminated `y' command"),
        ("s/a/b/pp", "char 8: multiple `p' options to `s' command"),
        ("s/a/b/gg", "char 8: multiple `g' options to `s' command"),
        ("s/a/b/1 2", "char 9: multiple number options to `s' command"),
        ("s/o/O/0", "char 7: number option to `s' command may not be zero"),
        ("a", "char 1: expected \\ after `a', `c' or `i'"),
        ("1{a foo;}", "char 0: unmatched `{'"),
        ("1,2q", "char 4: command only uses one address"),
        ("r", "char 1: missing filename in r/R/w/W commands"),
        ("s/a/b/w", "char 7: missing filename in r/R/w/W commands"),
        (
            "s/x/y/I;s//z/I",
            "char 14: cannot specify modifiers on empty regexp",
        ),
    ],
)
def test_errors_in_gnu_words(expr, why):
    assert _error(expr) == f"sed: -e expression #1, {why}"


def test_errors_number_the_pieces():
    assert _error("p", "k") == (
        "sed: -e expression #2, char 1: unknown command: `k'"
    )
    assert _error("p", "2 k") == (
        "sed: -e expression #2, char 3: unknown command: `k'"
    )
    assert _error("2", "p") == (
        "sed: -e expression #1, char 1: missing command"
    )
    assert _error("p", "{") == ("sed: -e expression #2, char 0: unmatched `{'")


def test_errors_name_a_script_file_and_line():
    def file(text: str) -> SedScriptPiece:
        return SedScriptPiece("file", text, "/s.sed")

    assert (
        str(_refusal([file("p\nk\n")]))
        == "sed: file /s.sed line 2: unknown command: `k'"
    )
    assert (
        str(_refusal([SedScriptPiece("expr", "p"), file("p\n\n 2 k\n")]))
        == "sed: file /s.sed line 3: unknown command: `k'"
    )
    assert (
        str(_refusal([file("2\n")]))
        == "sed: file /s.sed line 2: unknown command: `\n'"
    )
    assert (
        str(_refusal([file("p\n{\np\n")]))
        == "sed: file /s.sed line 2: unmatched `{'"
    )


def test_unknown_multibyte_command_names_its_first_byte():
    assert _error("2 é") == (
        "sed: -e expression #1, char 3: unknown command: `\udcc3'"
    )


def test_e_is_refused():
    assert _error("e echo hi") == (
        "sed: -e expression #1, char 1: `e' command not supported"
    )
    assert _error("s/b/X/e") == (
        "sed: -e expression #1, char 7: `e' command not supported"
    )


def test_missing_label_panics():
    err = _refusal([SedScriptPiece("expr", "bfoo")])
    assert str(err) == "sed: can't find label for jump to `foo'"
    assert err.exit_code == 4


def test_error_keeps_the_w_files_opened_before_it():
    err = _refusal(
        [SedScriptPiece("expr", "w /o"), SedScriptPiece("expr", "k")]
    )
    assert err.wfiles == ("/o",)


def test_delimiters_and_brackets():
    sub = _compile("s|a\\|b|X|").commands[0].subst
    assert sub is not None and sub.re is not None
    assert sub.re.pattern == "a|b"
    sub = _compile("s.a\\.b.X.").commands[0].subst
    assert sub is not None and sub.re is not None
    assert sub.re.pattern == "a.b"
    sub = _compile("s/[/]/X/").commands[0].subst
    assert sub is not None and sub.re is not None
    assert sub.re.pattern == "[/]"
    sub = _compile("s&a&[\\&]&").commands[0].subst
    assert sub is not None and sub.replacement == "[\\&]"


def test_y_escapes():
    [y] = _compile("y/ab\\//\\n\\tX/").commands
    assert y.y_src == ["a", "b", "/"]
    assert y.y_dst == ["\n", "\t", "X"]


def test_text_continues_into_the_next_piece():
    [a] = _compile("a\\", "foo\\", "bar").commands
    assert a.text == "foo\nbar\n"
    assert _compile("a\\").commands[0].text is None


def test_0r_prepends_on_line_1():
    [r] = _compile("0r /r").commands
    assert r.a1 == SedAddr("num", n=1)
    assert r.prepend
    assert _error("0,1r /r") == (
        "sed: -e expression #1, char 4: invalid usage of line address 0"
    )


@pytest.mark.parametrize(
    "expr,why",
    [
        ("s/\\(/x/", "char 7: Unmatched ( or \\("),
        ("s/\\)/x/", "char 7: Unmatched ) or \\)"),
        ("s/a\\{x\\}/y/", "char 11: Invalid content of \\{\\}"),
        ("s/a\\{2/x/", "char 9: Unmatched \\{"),
        ("s/a\\{3,1\\}/x/", "char 13: Invalid content of \\{\\}"),
        ("/\\(/p", "char 4: Unmatched ( or \\("),
        ("/\\(/Ip", "char 5: Unmatched ( or \\("),
        ("s/\\(/x/Ig", "char 9: Unmatched ( or \\("),
        ("s/\\(/x/;p", "char 8: Unmatched ( or \\("),
        ("s/\\(/x/ ; p", "char 9: Unmatched ( or \\("),
        ("s/[[:foo:]]/x/", "char 14: Invalid character class name"),
        ("s/[z-a]/x/", "char 10: Invalid range end"),
        ("s/\\x5c/X/", "char 9: Trailing backslash"),
        (
            "s/\\(a\\)/\\2/",
            "char 11: invalid reference \\2 on `s' command's RHS",
        ),
    ],
)
def test_bre_refusals_in_gnu_words(expr, why):
    assert _error(expr) == f"sed: -e expression #1, {why}"


@pytest.mark.parametrize(
    "expr,why",
    [
        ("s/(/x/", "char 6: Unmatched ( or \\("),
        ("s/)/x/", "char 6: Unmatched ) or \\)"),
        ("s/*a/x/", "char 7: Invalid preceding regular expression"),
        ("s/a|*b/x/", "char 9: Invalid preceding regular expression"),
        ("s/a{x}/y/", "char 9: Invalid content of \\{\\}"),
        ("s/a{1/x/", "char 8: Unmatched \\{"),
        (
            "s/(?<=id=)[0-9]+/X/",
            "char 19: Invalid preceding regular expression",
        ),
        ("s/a/\\1/", "char 7: invalid reference \\1 on `s' command's RHS"),
    ],
)
def test_ere_refusals_in_gnu_words(expr, why):
    err = _refusal([SedScriptPiece("expr", expr)], extended=True)
    assert str(err) == f"sed: -e expression #1, {why}"


def test_regex_refusal_comes_before_a_later_piece():
    assert _error("s/\\(/x/", "k") == (
        "sed: -e expression #1, char 7: Unmatched ( or \\("
    )
    assert _error("p", "s/\\(/x/") == (
        "sed: -e expression #2, char 7: Unmatched ( or \\("
    )


def test_class_without_outer_brackets_panics():
    err = _refusal([SedScriptPiece("expr", "s/[:alpha:]/x/")])
    assert str(err) == (
        "sed: character class syntax is [[:space:]], not [:space:]"
    )
    assert err.exit_code == 4
    assert len(_compile("s/[:]/x/").commands) == 1
    assert len(_compile("s/[[:alpha:]]/x/").commands) == 1


def test_accepts_what_glibc_accepts():
    assert len(_compile("s/*a/x/", "s/a{x}/y/", "s/a|b/X/").commands) == 3
    program = compile_script(
        [SedScriptPiece("expr", "s/a**/x/;s/a{,1}b/X/;s/()/x/")], True
    )
    assert len(program.commands) == 3


def test_a_utf8_script_reads_characters():
    program = compile_script(
        [SedScriptPiece("expr", "y/\u00e9/e/;s/\\xc3\\xa9/x/")], utf8=True
    )
    y, s = program.commands
    assert (y.y_src, y.y_dst) == (["\u00e9"], ["e"])
    assert s.subst is not None and s.subst.re is not None
    assert s.subst.re.source == "\u00e9"
    assert _error("y/\u00e9/e/") == (
        "sed: -e expression #1, char 7: "
        "strings for `y' command are different lengths"
    )
