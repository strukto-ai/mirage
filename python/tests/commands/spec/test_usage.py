from mirage.commands.spec.usage import (missing_value_error,
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
