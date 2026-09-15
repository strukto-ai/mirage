from mirage.commands.spec.usage import (  # yapf: disable
    ambiguous_option_error, extra_operand_error, invalid_argument_error,
    invalid_float_error, invalid_int_error, missing_required_error,
    missing_value_error, old_option_error, read_fail_exit, read_fail_exit_line,
    unknown_option_error, usage_exit_code)


def test_exit_codes_match_gnu():
    assert usage_exit_code("cat") == 1
    assert usage_exit_code("grep") == 2
    assert usage_exit_code("ls") == 2
    assert usage_exit_code("sort") == 2
    assert usage_exit_code("tar") == 64


def test_unknown_long_option_reports_full_token():
    msg, code = unknown_option_error("cat", "--bogus=x")
    assert msg == (b"cat: unrecognized option '--bogus=x'\n"
                   b"Try 'cat --help' for more information.\n")
    assert code == 1


def test_unknown_short_option_reports_char():
    msg, code = unknown_option_error("grep", "Y")
    assert msg == (b"grep: invalid option -- 'Y'\n"
                   b"Try 'grep --help' for more information.\n")
    assert code == 2


def test_find_uses_predicate_wording():
    msg, code = unknown_option_error("find", "--bogus")
    assert msg == b"find: unknown predicate `--bogus'\n"
    assert code == 1


def test_missing_value_short_and_long():
    msg, code = missing_value_error("grep", "m")
    assert msg.startswith(b"grep: option requires an argument -- 'm'\n")
    assert code == 2
    msg, code = missing_value_error("du", "--max-depth")
    assert msg.startswith(b"du: option '--max-depth' requires an argument\n")
    assert code == 1


def test_extra_operand_uses_gnu_wording_and_exit():
    err = extra_operand_error("uniq", "c.txt")
    assert str(err) == ("uniq: extra operand 'c.txt'\n"
                        "Try 'uniq --help' for more information.")
    assert err.exit_code == 1


def test_extra_operand_diff_prefixes_hint_and_exits_2():
    err = extra_operand_error("diff", "c.txt")
    assert str(err) == ("diff: extra operand 'c.txt'\n"
                        "diff: Try 'diff --help' for more information.")
    assert err.exit_code == 2


def test_extra_operand_mktemp_says_too_many_templates():
    err = extra_operand_error("mktemp", "t2")
    assert str(err).startswith("mktemp: too many templates\n")
    assert err.exit_code == 1


def test_invalid_argument_matches_gnu_argmatch_shape():
    stderr, code = invalid_argument_error(
        "tee", "--output-error", "bogus",
        ("warn", "warn-nopipe", "exit", "exit-nopipe"))
    assert stderr == (b"tee: invalid argument 'bogus' for '--output-error'\n"
                      b"Valid arguments are:\n"
                      b"  - 'warn'\n  - 'warn-nopipe'\n"
                      b"  - 'exit'\n  - 'exit-nopipe'\n"
                      b"Try 'tee --help' for more information.\n")
    assert code == 1


def test_missing_required_names_the_canonical_spelling():
    stderr, code = missing_required_error("mycmd", "--out")
    assert stderr == (b"mycmd: option '--out' is required\n"
                      b"Try 'mycmd --help' for more information.\n")
    assert code == 1


def test_ambiguous_option_matches_gnu_shape():
    out, code = ambiguous_option_error("grep", "--c",
                                       ("--context", "--color", "--count"))
    assert out == (b"grep: option '--c' is ambiguous; possibilities: "
                   b"'--context' '--color' '--count'\n"
                   b"Try 'grep --help' for more information.\n")
    assert code == 2


def test_invalid_int_mirrors_argparse_wording():
    out, code = invalid_int_error("mycli", "--port", "abc")
    assert out == (b"mycli: invalid int value: 'abc' for '--port'\n"
                   b"Try 'mycli --help' for more information.\n")
    assert code == 1


def test_invalid_float_mirrors_argparse_wording():
    out, code = invalid_float_error("mycli", "--ratio", "5x")
    assert out == (b"mycli: invalid float value: '5x' for '--ratio'\n"
                   b"Try 'mycli --help' for more information.\n")
    assert code == 1


def test_old_option_error_matches_gnu_tar_wording():
    out, code = old_option_error("tar", "f")
    assert out == (b"tar: Old option 'f' requires an argument.\n"
                   b"Try 'tar --help' for more information.\n")
    # tar's own fatal error, not argp's 64.
    assert code == 2


def test_read_fail_exit_reads_the_code_off_the_command():
    # GNU's code for a failed read belongs to the command, not the errno.
    assert read_fail_exit("cat", FileNotFoundError("/x")) == 1
    assert read_fail_exit("sort", FileNotFoundError("/x")) == 2
    assert read_fail_exit("sort", IsADirectoryError("/x")) == 2
    assert read_fail_exit("unzip", FileNotFoundError("/x")) == 9


def test_read_fail_exit_splits_by_errno_for_the_four_that_do():
    # sed opens the directory and fails on the read (4) where a missing
    # file fails at open (2); the gzip family calls a directory a warning
    # (2) and a missing file an error (1); zgrep inverts that.
    assert read_fail_exit("sed", IsADirectoryError("/d")) == 4
    assert read_fail_exit("sed", FileNotFoundError("/x")) == 2
    assert read_fail_exit("zcat", IsADirectoryError("/d")) == 2
    assert read_fail_exit("zcat", FileNotFoundError("/x")) == 1
    assert read_fail_exit("zgrep", IsADirectoryError("/d")) == 1
    assert read_fail_exit("zgrep", FileNotFoundError("/x")) == 2


def test_read_fail_exit_ignores_anything_that_is_not_a_failed_read():
    # The executor's chokepoints catch every error a command can raise, so
    # a table keyed by command has to be gated on the narrow errno set.
    # A bad script is not a filesystem error at all, and EACCES is as
    # often a write refusal as a read one: `sed -i` on a backend with no
    # write op raises PermissionError and must stay 1, which is what
    # integ's lancedb_sed_i_readonly and notion_sed_i_readonly pin.
    assert read_fail_exit("sed", PermissionError("-i not supported")) == 1
    assert read_fail_exit("sed", ValueError("bad script")) == 1
    assert read_fail_exit("sort", PermissionError("/locked")) == 1
    assert read_fail_exit("sort", RuntimeError("transport")) == 1


def test_read_fail_exit_line_reads_the_terminal_errno():
    # The cross-mount stream path only has the rendered line, and the
    # errno is its LAST field. A path is free to spell a strerror itself,
    # and scanning the whole line read this directory as ENOENT.
    line = b"sed: /ram/No such file or directory: Is a directory\n"
    assert read_fail_exit_line("sed", line) == 4
    assert read_fail_exit_line("cat", line) == 1
    assert read_fail_exit_line(
        "sed", b"sed: /ram/Is a directory: No such file or directory\n") == 2


def test_read_fail_exit_line_takes_the_most_severe_of_a_blob():
    # One fetch renders several lines when the operand was a glob the
    # owning mount expanded, and sed's rule is the most severe.
    blob = (b"sed: /ram/nope: No such file or directory\n"
            b"sed: /ram/dir: Is a directory\n")
    assert read_fail_exit_line("sed", blob) == 4
    assert read_fail_exit_line("sort", blob) == 2


def test_read_fail_exit_line_keeps_the_catch_all_for_anything_else():
    # A line that carries no strerror is not a failed read, and neither
    # is one whose only strerror sits inside the path.
    assert read_fail_exit_line("sed", b"sed: -e expression #1: unknown\n") == 1
    assert read_fail_exit_line("sed", b"") == 1
    assert read_fail_exit_line("sed", b"sed: /ram/Is a directory\n") == 1


def test_curl_usage_errors_exit_2():
    assert usage_exit_code("curl") == 2


def test_curl_unknown_option_uses_curl_wording():
    # Pinned on curl 8.14.1 (debian:stable-slim): one message line, then
    # curl's own help hint. A cluster letter is reported dashed.
    hint = "curl: try 'curl --help' or 'curl --manual' for more information\n"
    assert unknown_option_error(
        "curl",
        "--bogus") == (("curl: option --bogus: is unknown\n" + hint).encode(),
                       2)
    assert unknown_option_error(
        "curl", "Y") == (("curl: option -Y: is unknown\n" + hint).encode(), 2)


def test_curl_missing_value_uses_curl_wording():
    hint = "curl: try 'curl --help' or 'curl --manual' for more information\n"
    assert missing_value_error(
        "curl",
        "m") == (("curl: option -m: requires parameter\n" + hint).encode(), 2)
    assert missing_value_error(
        "curl",
        "--max-time") == (("curl: option --max-time: requires parameter\n" +
                           hint).encode(), 2)


def test_curl_bad_number_uses_curl_wording():
    hint = "curl: try 'curl --help' or 'curl --manual' for more information\n"
    assert invalid_float_error("curl", "--max-time", "abc") == (
        ("curl: option --max-time: expected a proper numerical parameter\n" +
         hint).encode(), 2)
