import pytest

from mirage.workspace.executor.builtins.script import parse_bash_args


def test_parse_bash_args_file_operand_ends_option_parsing():
    parsed = parse_bash_args(["run.sh", "-x", "a"])
    assert parsed.path == "run.sh"
    assert parsed.argv == ["-x", "a"]
    assert parsed.settings == ()


def test_parse_bash_args_double_dash_protects_a_flag_shaped_file():
    parsed = parse_bash_args(["--", "-weird.sh", "a"])
    assert parsed.path == "-weird.sh"
    assert parsed.argv == ["a"]


def test_parse_bash_args_single_dash_ends_option_parsing():
    parsed = parse_bash_args(["-", "run.sh"])
    assert parsed.path == "run.sh"


def test_parse_bash_args_clustered_c_keeps_set_options():
    parsed = parse_bash_args(["-xc", "echo hi", "name", "a"])
    assert parsed.script == "echo hi"
    assert parsed.argv == ["name", "a"]
    assert parsed.settings == (("xtrace", True),)


def test_parse_bash_args_maps_set_flags_to_options():
    parsed = parse_bash_args(["-eux", "run.sh"])
    assert parsed.path == "run.sh"
    assert parsed.settings == (
        ("errexit", True),
        ("nounset", True),
        ("xtrace", True),
    )


def test_parse_bash_args_last_sign_wins_within_one_invocation():
    parsed = parse_bash_args(["-e", "+e", "run.sh"])
    assert parsed.path == "run.sh"
    assert parsed.settings == (("errexit", True), ("errexit", False))


def test_parse_bash_args_dash_s_keeps_operands_positional():
    parsed = parse_bash_args(["-s", "A", "B"])
    assert parsed.path is None and parsed.script is None
    assert parsed.argv == ["A", "B"]


def test_parse_bash_args_applies_o_and_its_value():
    parsed = parse_bash_args(["-o", "pipefail", "run.sh"])
    assert parsed.path == "run.sh"
    assert parsed.settings == (("pipefail", True),)


def test_parse_bash_args_long_option_consumes_its_value():
    parsed = parse_bash_args(["--rcfile", "rc", "run.sh"])
    assert parsed.path == "run.sh"


def test_parse_bash_args_unsupported_short_option():
    assert parse_bash_args(["-Z"]).invalid == "-Z"


def test_parse_bash_args_unsupported_long_option():
    assert parse_bash_args(["--nosuch", "run.sh"]).invalid == "--nosuch"


def test_parse_bash_args_dash_c_needs_a_value():
    assert parse_bash_args(["-c"]).needs_value == "-c"


@pytest.mark.parametrize(
    "args,field,expected",
    [
        (["--version", "--help"], "help", True),
        (
            ["--posix", "--verbose", "-c", ":"],
            "settings",
            (("posix", True), ("verbose", True)),
        ),
    ],
)
def test_parse_bash_args_reads_long_options_first(args, field, expected):
    """bash 5.2.37 on debian:stable-slim: long options lead, then short."""
    assert getattr(parse_bash_args(args), field) == expected
