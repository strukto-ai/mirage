# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import pytest

from mirage.commands.cli.refusal import (
    ARGPARSE_EXIT,
    clap_missing_operands,
    clap_supplied,
    git_option_refusal,
    git_usage,
    leaf_refusal,
)
from mirage.commands.spec.types import Argument, CommandSpec, UsageStyle
from mirage.workspace.executor.command.types import ParsedCommand

ARGPARSE_MESSAGE = b"gws gmail: unrecognized option '--nosuch'\n"


def _parsed(invalid: list[str]) -> ParsedCommand:
    """A parse result carrying the given invalid options.

    Args:
        invalid (list[str]): offending tokens as the flat parser
            reports them.
    """
    return ParsedCommand(
        flag_kwargs={},
        paths=[],
        texts=(),
        warnings=[],
        invalid_options=invalid,
        ambiguous_options=[],
        option_error_kinds=[],
        needs_value_options=[],
        invalid_value_options=[],
        ambiguous_value_options=[],
        invalid_int_options=[],
        invalid_float_options=[],
        missing_required_options=[],
    )


SPEC = CommandSpec(
    arguments=(
        Argument("-q", "--quiet", action="store_true", help="be quiet"),
        Argument("--no-quiet", action="store_true", help="be loud"),
        Argument("-m", metavar="msg", help="message"),
        Argument("--count", type="int", help="how many"),
        Argument(
            "--abbrev",
            type="int",
            nargs="?",
            attached_only=True,
            help="abbreviate",
        ),
        Argument("--ignore-unmatch", action="store_true", help="exit zero"),
        Argument("--no-ignore-unmatch", action="store_true", help="fail"),
        Argument(
            "-i", "--interactive-mode", action="store_true", help="too long"
        ),
    )
)
USAGE = (
    "usage: git rm [-f | --force] [-r] [--cached] [--ignore-unmatch]\n"
    "              [--quiet] [--] [<pathspec>...]\n"
    "\n"
    "    -q, --[no-]quiet      be quiet\n"
    "    -m <msg>              message\n"
    "    --count <count>       how many\n"
    "    --abbrev[=<abbrev>]   abbreviate\n"
    "    --[no-]ignore-unmatch exit zero\n"
    "    -i, --interactive-mode\n"
    "                          too long\n"
    "\n"
)


def _parsed_with(**fields) -> ParsedCommand:
    """A parse result with the given fields set over an empty one.

    Args:
        **fields: the ParsedCommand fields to set.
    """
    return _parsed([])._replace(**fields)


# parse-options' layout, pinned against git 2.47.3: synopsis lines, then
# the rows with help from column 26, a 25-wide spelling one space short
# of it and a wider one on a line of its own, and `--[no-]` where git's
# own table spells the long so.
def test_git_usage_lays_rows_out_as_parse_options_does():
    assert git_usage("rm", SPEC) == USAGE


# log has no table, and git lists a `--no-` filter like `--no-merges`
# apart from the option it looks like a negation of.
def test_git_usage_keeps_a_negation_apart_where_git_does():
    rows = git_usage("log", SPEC)
    assert "    -q, --quiet           be quiet\n" in rows
    assert "    --no-quiet            be loud\n" in rows


def test_git_usage_closes_a_verb_without_options_with_a_blank_line():
    assert git_usage("version", CommandSpec()) == "usage: git version\n\n"


# Pinned against git 2.50.1: a long option is named without its dashes
# and a short one is a switch, both before the usage block; `-h` puts the
# usage on stdout; a boolean handed a value is refused on one line.
@pytest.mark.parametrize(
    ("word", "streams"),
    [
        ("--nosuch", ("", f"error: unknown option `nosuch'\n{USAGE}")),
        ("-Z", ("", f"error: unknown switch `Z'\n{USAGE}")),
        ("-h", (USAGE, "")),
        ("--quiet=1", ("", "error: option `quiet' takes no value\n")),
    ],
)
def test_git_option_refusal_words_it_as_parse_options_does(word, streams):
    assert git_option_refusal(word, "rm", SPEC) == streams


# parse-options names the last two options an abbreviation matched, each
# with the `no-` it was matched under, puts the usage on stdout and exits
# 129 (git 2.50.1).
def test_git_words_an_ambiguous_abbreviation_its_own_way():
    parsed = _parsed_with(
        ambiguous_options=[("--no-m=x", ("--no-merged", "--no-move"))],
        option_error_kinds=["ambiguous"],
    )
    assert leaf_refusal(
        UsageStyle.GIT, ARGPARSE_MESSAGE, parsed, "rm", SPEC
    ) == (
        b"error: ambiguous option: no-m=x "
        b"(could be --no-merged or --no-move)\n",
        129,
        USAGE.encode(),
    )


def test_git_names_a_short_cluster_letter_the_parser_reports_bare():
    parsed = _parsed_with(
        invalid_options=["Z"], option_error_kinds=["invalid"]
    )
    msg, code, shown = leaf_refusal(
        UsageStyle.GIT, ARGPARSE_MESSAGE, parsed, "rm", SPEC
    )
    assert (msg, code, shown) == (
        f"error: unknown switch `Z'\n{USAGE}".encode(),
        129,
        None,
    )


@pytest.mark.parametrize(
    ("needy", "line"),
    [
        ("--count", b"error: option `count' requires a value\n"),
        ("m", b"error: switch `m' requires a value\n"),
    ],
)
def test_git_words_a_missing_value_on_one_line(needy, line):
    parsed = _parsed_with(
        needs_value_options=[needy], option_error_kinds=["needs_value"]
    )
    assert leaf_refusal(
        UsageStyle.GIT, ARGPARSE_MESSAGE, parsed, "rm", SPEC
    ) == (line, 129, None)


def test_the_default_style_is_left_exactly_as_it_was():
    # Every other installed CLI has to keep argparse's shape and its
    # exit 2: an installed name is not a GNU tool with a pinned exit.
    parsed = _parsed_with(
        invalid_options=["--nosuch"], option_error_kinds=["invalid"]
    )
    assert leaf_refusal(
        UsageStyle.ARGPARSE, ARGPARSE_MESSAGE, parsed, "rm", SPEC
    ) == (ARGPARSE_MESSAGE, ARGPARSE_EXIT, None)


def test_git_keeps_the_argparse_wording_for_errors_it_shares():
    # A refusal git has no wording of its own for keeps the spec
    # machinery's message, and only the exit code moves.
    assert leaf_refusal(
        UsageStyle.GIT, ARGPARSE_MESSAGE, _parsed([]), "rm", SPEC
    ) == (ARGPARSE_MESSAGE, 129, None)


def test_clap_names_the_empty_slot_and_echoes_what_was_supplied():
    # Pinned against the real ntn 0.21.9 (integ/ntn_conformance.ts runs
    # the same line through it): the slot is named under a fixed
    # heading, the usage line carries the options the line actually
    # typed, and the footer points at --help.
    spec = CommandSpec(
        arguments=(
            Argument("--json", action="store_true"),
            Argument("--limit", type="int"),
            Argument("PAGE_ID"),
        )
    )
    msg = clap_missing_operands(
        "ntn pages get", spec, ["PAGE_ID"], ["--json"], {}
    )
    assert msg.decode() == (
        "error: the following required arguments were not provided:\n"
        "  <PAGE_ID>\n\n"
        "Usage: ntn pages get --json <PAGE_ID>\n\n"
        "For more information, try '--help'.\n"
    )


def test_clap_usage_echoes_typed_options_in_the_order_typed():
    spec = CommandSpec(
        arguments=(
            Argument("--limit", type="int"),
            Argument("--sort"),
            Argument("ID"),
        )
    )
    # No metavar declared, so both names derive from the long spelling.
    assert clap_supplied(spec, ["--limit", "--sort"], {}) == [
        "--limit <LIMIT>",
        "--sort <SORT>",
    ]
    assert clap_supplied(spec, ["--sort", "--limit"], {}) == [
        "--sort <SORT>",
        "--limit <LIMIT>",
    ]


def test_clap_usage_appends_env_sourced_options_after_the_typed_ones():
    # An env-sourced option counts as supplied and lands last, which is
    # what the real binary prints with NOTION_API_VERSION set.
    spec = CommandSpec(
        arguments=(
            Argument("--json", action="store_true"),
            Argument(
                "--notion-version", metavar="VERSION", env="NOTION_API_VERSION"
            ),
            Argument("PAGE_ID"),
        )
    )
    env = {"NOTION_API_VERSION": "2025-09-03"}
    assert clap_supplied(spec, ["--json"], env) == [
        "--json",
        "--notion-version <VERSION>",
    ]
    # Unset, it is simply not supplied.
    assert clap_supplied(spec, ["--json"], {}) == ["--json"]


def test_clap_usage_omits_a_merely_defaulted_option():
    # GNU-style defaults are invisible to clap's usage line: only what
    # the line carried (or an env supplied) is echoed. The parser hands
    # over typed dests precisely so this stays true.
    spec = CommandSpec(
        arguments=(
            Argument("--limit", type="int", default="25"),
            Argument("ID"),
        )
    )
    assert clap_supplied(spec, [], {}) == []


def test_clap_exits_two_like_argparse_but_for_its_own_reason():
    assert leaf_refusal(
        UsageStyle.CLAP, ARGPARSE_MESSAGE, _parsed([]), "rm", SPEC
    ) == (ARGPARSE_MESSAGE, 2, None)
