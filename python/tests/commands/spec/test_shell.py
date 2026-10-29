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


def test_given_lists_every_option_in_order():
    parse = parse_shell_options(
        SHELL_SPECS["xargs"], ["-L1", "-I", "{}", "-n2", "-L3", "echo"]
    )
    assert parse.given == [("L", "1"), ("I", "{}"), ("n", "2"), ("L", "3")]
    assert parse.flags == {"L": "3", "I": "{}", "n": "2"}
    assert parse.operands == ["echo"]


def test_optional_value_is_taken_only_when_attached():
    spec = SHELL_SPECS["xargs"]
    assert parse_shell_options(spec, ["-iZ", "echo"]).flags == {"i": "Z"}
    bare = parse_shell_options(spec, ["-i", "Z"])
    assert bare.flags == {"i": True}
    assert bare.operands == ["Z"]
    assert parse_shell_options(spec, ["--replace=Z", "x"]).flags == {"i": "Z"}
    long_bare = parse_shell_options(spec, ["--max-lines", "2"])
    assert long_bare.flags == {"l": True}
    assert long_bare.operands == ["2"]
    assert parse_shell_options(spec, ["-ri"]).flags == {"r": True, "i": True}


def test_long_value_flag_missing_value_keeps_its_dashes():
    parse = parse_shell_options(SHELL_SPECS["xargs"], ["--max-args"])
    assert parse.needs_value == "--max-args"
    parse = parse_shell_options(SHELL_SPECS["xargs"], ["--max-p"])
    assert parse.needs_value == "--max-procs"


def test_long_option_resolves_an_abbreviation():
    spec = SHELL_SPECS["xargs"]
    assert parse_shell_options(spec, ["--max-a=1", "e"]).given == [("n", "1")]
    parse = parse_shell_options(spec, ["--max-a", "1", "e"])
    assert parse.given == [("n", "1")]
    assert parse.operands == ["e"]
    assert parse_shell_options(spec, ["--hel"]).given == [("help", True)]
    assert parse_shell_options(spec, ["--rep=Z"]).given == [("i", "Z")]
    assert parse_shell_options(
        SHELL_SPECS["timeout"], ["--si", "KILL"]
    ).given == [("s", "KILL")]


def test_ambiguous_abbreviation_names_every_candidate_in_order():
    spec = SHELL_SPECS["xargs"]
    parse = parse_shell_options(spec, ["--max", "1"])
    assert parse.invalid == "--max"
    assert parse.candidates == (
        "--max-lines",
        "--max-args",
        "--max-chars",
        "--max-procs",
    )
    assert parse_shell_options(spec, ["--ver"]).candidates == (
        "--verbose",
        "--version",
    )
    empty = parse_shell_options(spec, ["--=x"])
    assert empty.invalid == "--=x"
    assert empty.candidates[:2] == ("--null", "--arg-file")
    unknown = parse_shell_options(spec, ["--bogus"])
    assert unknown.invalid == "--bogus"
    assert unknown.candidates == ()


def test_value_on_a_no_argument_long_option_is_reported():
    spec = SHELL_SPECS["xargs"]
    assert parse_shell_options(spec, ["--nu=x"]).unexpected_value == "--null=x"
    assert (
        parse_shell_options(spec, ["--help=x"]).unexpected_value == "--help=x"
    )


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
    parse = parse_shell_options(
        SHELL_SPECS["timeout"], ["--preserve-status", "1", "sleep", "3"]
    )
    assert parse.flags == {"p": True}
    assert parse.operands == ["1", "sleep", "3"]


def test_read_dash_r():
    parse = parse_shell_options(SHELL_SPECS["read"], ["-r", "v"])
    assert parse.flags == {"r": True}
    assert parse.operands == ["v"]


def test_options_preserve_aliases_clusters_and_partial_parse():
    for tail in (["-q"], ["--max-args"]):
        parse = parse_shell_options(
            SHELL_SPECS["xargs"], ["-0rn0", "--max-args=2", *tail]
        )
        assert parse.given == [
            ("0", True),
            ("r", True),
            ("n", "0"),
            ("n", "2"),
        ]
        assert parse.invalid == ("q" if tail == ["-q"] else None)
        assert parse.needs_value == (
            "--max-args" if tail == ["--max-args"] else None
        )


def test_every_short_spelling_of_an_option_is_read():
    for word in ("-?", "-h", "--help", "--he"):
        parsed = parse_shell_options(SHELL_SPECS["man"], [word, "ls"])
        assert (parsed.flags, parsed.operands) == ({"?": True}, ["ls"])
