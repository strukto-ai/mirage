from mirage.commands.spec.shell import SHELL_SPECS, parse_shell_options


def test_bool_and_value_flags_parse():
    parse = parse_shell_options(SHELL_SPECS["xargs"], ["-r", "-n", "2", "wc"])
    assert parse.flags == {"r": True, "n": "2"}
    assert parse.operands == ["wc"]
    assert parse.invalid is None
    assert parse.needs_value is None


def test_attached_value_and_cluster():
    parse = parse_shell_options(SHELL_SPECS["xargs"], ["-rn2", "echo"])
    assert parse.flags == {"r": True, "n": "2"}
    assert parse.operands == ["echo"]


def test_long_flag_with_equals():
    parse = parse_shell_options(SHELL_SPECS["xargs"], ["--max-args=3", "wc"])
    assert parse.flags == {"n": "3"}
    assert parse.operands == ["wc"]


def test_options_stop_at_first_operand():
    parse = parse_shell_options(SHELL_SPECS["xargs"], ["echo", "-n"])
    assert parse.flags == {}
    assert parse.operands == ["echo", "-n"]


def test_double_dash_ends_options():
    parse = parse_shell_options(SHELL_SPECS["xargs"], ["--", "-r", "echo"])
    assert parse.flags == {}
    assert parse.operands == ["-r", "echo"]


def test_invalid_short_option_reported():
    parse = parse_shell_options(SHELL_SPECS["xargs"], ["-q", "echo"])
    assert parse.invalid == "q"


def test_invalid_long_option_reported():
    parse = parse_shell_options(SHELL_SPECS["xargs"], ["--bogus", "echo"])
    assert parse.invalid == "--bogus"


def test_value_flag_missing_value_reported():
    parse = parse_shell_options(SHELL_SPECS["xargs"], ["-n"])
    assert parse.needs_value == "n"


def test_timeout_long_bool_flag():
    parse = parse_shell_options(SHELL_SPECS["timeout"],
                                ["--preserve-status", "1", "sleep", "3"])
    assert parse.flags == {"preserve-status": True}
    assert parse.operands == ["1", "sleep", "3"]


def test_read_dash_r():
    parse = parse_shell_options(SHELL_SPECS["read"], ["-r", "v"])
    assert parse.flags == {"r": True}
    assert parse.operands == ["v"]
