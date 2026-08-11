from mirage.commands.spec.usage import (  # yapf: disable
    ambiguous_option_error, extra_operand_error, invalid_argument_error,
    invalid_float_error, invalid_int_error, missing_required_error,
    missing_value_error, old_option_error, unknown_option_error,
    usage_exit_code)


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
