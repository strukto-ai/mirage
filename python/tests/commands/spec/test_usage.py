from mirage.commands.spec.usage import (  # yapf: disable
    ambiguous_option_error, argmatch_error, argmatch_line,
    argmatch_valid_block, extra_operand_error, invalid_argument_error,
    invalid_float_error, invalid_int_error, missing_required_error,
    missing_value_error, old_option_error, read_fail_exit, read_fail_exit_line,
    unexpected_value_error, unknown_option_error, usage_exit_code)


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


# GNU getopt_long refuses a value on a BOOLEAN long option with its own
# message, which is not the unrecognized-option one: it names the option
# and drops the value, where the unrecognized message quotes the whole
# token. Measured on GNU grep 3.11 and coreutils 9.4 (new ground-truth
# section W): `grep --byte-offset=2`, `nl --help=2`, `cut --complement=2`,
# `sed --debug=2`. The per-tool usage block GNU prints between the message
# and the hint is omitted here, as it is for every other refusal in this
# module.
def test_boolean_long_with_a_value_names_the_option_without_it():
    msg, code = unexpected_value_error("grep", "--byte-offset=2")
    assert msg == (b"grep: option '--byte-offset' doesn't allow an argument\n"
                   b"Try 'grep --help' for more information.\n")
    assert code == 2


def test_boolean_long_with_a_value_carries_the_commands_exit_code():
    """coreutils exit 1 where grep and sort exit 2."""
    for name, expected in (("nl", 1), ("cut", 1), ("wc", 1), ("sort", 2)):
        msg, code = unexpected_value_error(name, "--bogus-bool=2")
        assert msg.startswith(
            f"{name}: option '--bogus-bool' doesn't allow an argument\n".
            encode())
        assert code == expected


def test_boolean_long_with_an_empty_value_still_refuses():
    """`grep --byte-offset=` is the same refusal: the `=` is enough."""
    msg, _ = unexpected_value_error("grep", "--byte-offset=")
    assert msg.startswith(
        b"grep: option '--byte-offset' doesn't allow an argument\n")


def test_boolean_long_with_two_equals_names_only_the_option():
    """Measured: `grep --byte-offset=2=3` still names `--byte-offset`."""
    msg, _ = unexpected_value_error("grep", "--byte-offset=2=3")
    assert msg.startswith(
        b"grep: option '--byte-offset' doesn't allow an argument\n")


def test_a_program_that_is_not_getopt_long_keeps_its_unknown_wording():
    """curl, python, jq and find answer this as an unknown option.

    Each measured: `curl --silent=2` is `option --silent=2: is unknown`,
    `python3 --version=2` is `unknown option --version=2`, and
    `jq --tab=2` is jq's own unknown-option line. Routing them through
    the getopt_long wording would put GNU's words in a program that does
    not use GNU's parser.
    """
    msg, code = unexpected_value_error("curl", "--silent=2")
    assert msg.startswith(b"curl: option --silent=2: is unknown\n")
    assert code == 2
    msg, _ = unexpected_value_error("jq", "--tab=2")
    assert msg.startswith(b"jq: unrecognized option '--tab=2'\n")
    msg, _ = unexpected_value_error("python3", "--version=2")
    assert msg.startswith(b"unknown option --version=2\n")
    msg, _ = unexpected_value_error("find", "--help=2")
    assert msg == b"find: unknown predicate `--help=2'\n"


def test_unknown_option_leaves_the_token_unescaped():
    """getopt prints `argv[optind]` with a plain `%s`, never quote().

    Every coreutils clause that names a *value* runs it through gnulib's
    `quote()` (an `é` comes back as `\\303\\251`), but the
    unrecognized-option clause is getopt's own and carries the token's
    bytes as typed. Measured under `LC_ALL=C` with a raw `bytes` argv on
    coreutils 9.4: `cut --zzz=é` reports `'--zzz=é'` with the two UTF-8
    bytes intact, and `wc --zzz=$'\\001'` carries the raw 0x01. Same for
    nl, expand, shuf, tail, split, du, sort, uniq, ls and cp. This
    asymmetry is deliberate; do not route this clause through quote().
    """
    msg, _ = unknown_option_error("cut", "--zzz=é")
    assert msg.startswith("cut: unrecognized option '--zzz=é'\n".encode())
    msg, _ = unknown_option_error("wc", "--zzz=\x01")
    assert msg.startswith(b"wc: unrecognized option '--zzz=\x01'\n")


# Every row below is a measured GNU coreutils 9.4 answer under
# `LC_ALL=C LANG=C TZ=UTC`, with a raw `bytes` argv so a non-UTF-8
# value is reachable (ground truth QS.1 and QS.3a). Mirrored in
# usage.test.ts.
def test_invalid_argument_escapes_the_word_through_quote():
    r"""`tee --output-error=xe-acute` is
    `tee: invalid argument 'xÃ©' for '--output-error'`, exit 1.

    Two octal escapes, not one character: gnulib's `quote()` counts
    bytes and nothing above 0x7f is printable in the C locale.
    """
    stderr, code = invalid_argument_error(
        "tee", "--output-error", "xé",
        ("warn", "warn-nopipe", "exit", "exit-nopipe"))
    assert stderr.startswith(
        rb"tee: invalid argument 'x\303\251' for '--output-error'"
        b"\n")
    assert code == 1


def test_an_empty_argmatch_value_is_ambiguous_not_invalid():
    """GNU: `tee --output-error=` is `ambiguous argument ''`, exit 1.

    gnulib's argmatch matches on a prefix and `""` is a prefix of every
    candidate, so it comes back ambiguous. Measured the same way at
    `tail --follow=`, `sort --check=`, `wc --total=`,
    `uniq --all-repeated=`, `uniq --group=`, `ls --format=`,
    `ls -l --time-style=` and `cp --update=`.
    """
    stderr, code = invalid_argument_error(
        "tee", "--output-error", "",
        ("warn", "warn-nopipe", "exit", "exit-nopipe"))
    assert stderr.startswith(
        b"tee: ambiguous argument '' for '--output-error'\n")
    assert code == 1


def test_argmatch_line_words_both_kinds_and_quotes_the_slot():
    assert argmatch_line("ls", "time style",
                         "x") == ("ls: invalid argument 'x' for 'time style'")
    assert argmatch_line("ls", "time style",
                         "") == ("ls: ambiguous argument '' for 'time style'")


def test_argmatch_valid_block_joins_aliases_of_one_value():
    """GNU `sort --check=x` prints `  - 'quiet', 'silent'` on ONE line.

    `argmatch_valid` starts a new `  - ` row only when the VALUE
    changes, so two spellings of one value share a row.
    """
    assert argmatch_valid_block(
        (("quiet", "silent"),
         ("diagnose-first", ))) == ("Valid arguments are:\n"
                                    "  - 'quiet', 'silent'\n"
                                    "  - 'diagnose-first'")


def test_argmatch_error_carries_the_block_and_the_given_code():
    err = argmatch_error("sort", "--check", "x",
                         (("quiet", "silent"), ("diagnose-first", )), 1)
    assert str(err) == ("sort: invalid argument 'x' for '--check'\n"
                        "Valid arguments are:\n"
                        "  - 'quiet', 'silent'\n"
                        "  - 'diagnose-first'\n"
                        "Try 'sort --help' for more information.")
    # sort's other usage errors are 2; gnulib's `argmatch_die` always
    # calls `usage (EXIT_FAILURE)`, so this one is 1.
    assert err.exit_code == 1
    assert usage_exit_code("sort") == 2
