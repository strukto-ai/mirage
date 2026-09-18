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

from mirage.commands.cli.refusal import (ARGPARSE_EXIT, clap_missing_operands,
                                         clap_supplied, git_unknown_option,
                                         leaf_refusal)
from mirage.commands.cli.specs import cli_spec_for
from mirage.commands.spec.types import CommandSpec, Operand, Option, UsageStyle
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.executor.command.types import ParsedCommand

ARGPARSE_MESSAGE = b"gws gmail: unrecognized option '--nosuch'\n"


def _parsed(invalid: list[str]) -> ParsedCommand:
    """A parse result carrying the given invalid options.

    Args:
        invalid (list[str]): offending tokens as the flat parser
            reports them.
    """
    return ParsedCommand(flag_kwargs={},
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
                         missing_required_options=[])


# Pinned against git 2.50.1: `git status --nosuch` and `git status -Z`.
def test_git_names_a_long_option_without_its_dashes():
    assert git_unknown_option(
        "--nosuch") == b"error: unknown option `nosuch'\n"


def test_git_calls_a_short_option_a_switch():
    assert git_unknown_option("Z") == b"error: unknown switch `Z'\n"


def test_a_dashed_short_token_is_stripped_too():
    assert git_unknown_option("-Z") == b"error: unknown switch `Z'\n"


def test_the_git_style_exits_129():
    _msg, code = leaf_refusal(UsageStyle.GIT, ARGPARSE_MESSAGE,
                              _parsed(["--nosuch"]))
    assert code == 129


def test_the_git_style_replaces_the_argparse_wording():
    msg, _code = leaf_refusal(UsageStyle.GIT, ARGPARSE_MESSAGE,
                              _parsed(["--nosuch"]))
    assert msg == b"error: unknown option `nosuch'\n"


def test_the_default_style_is_left_exactly_as_it_was():
    # Every other installed CLI has to keep argparse's shape and its
    # exit 2: an installed name is not a GNU tool with a pinned exit.
    msg, code = leaf_refusal(UsageStyle.ARGPARSE, ARGPARSE_MESSAGE,
                             _parsed(["--nosuch"]))
    assert msg == ARGPARSE_MESSAGE
    assert code == ARGPARSE_EXIT


def test_git_keeps_the_argparse_wording_for_errors_it_shares():
    # A missing value on a flag git does declare is not the unknown
    # option case, so only the exit code moves.
    msg, code = leaf_refusal(UsageStyle.GIT, ARGPARSE_MESSAGE, _parsed([]))
    assert msg == ARGPARSE_MESSAGE
    assert code == 129


def test_clap_names_the_empty_slot_and_echoes_what_was_supplied():
    # Pinned against the real ntn 0.21.9 (integ/ntn_conformance.ts runs
    # the same line through it): the slot is named under a fixed
    # heading, the usage line carries the options the line actually
    # typed, and the footer points at --help.
    spec = CommandSpec(
        options=(Option(long="--json",
                        type="bool"), Option(long="--limit", type="int")),
        positional=(Operand(type="str", name="PAGE_ID", required=True), ),
    )
    msg = clap_missing_operands("ntn pages get", spec, ["PAGE_ID"], ["--json"],
                                {})
    assert msg.decode() == (
        "error: the following required arguments were not provided:\n"
        "  <PAGE_ID>\n\n"
        "Usage: ntn pages get --json <PAGE_ID>\n\n"
        "For more information, try '--help'.\n")


def test_clap_usage_echoes_typed_options_in_the_order_typed():
    spec = CommandSpec(options=(Option(long="--limit", type="int"),
                                Option(long="--sort", type="str")),
                       positional=(Operand(type="str",
                                           name="ID",
                                           required=True), ))
    # No metavar declared, so both names derive from the long spelling.
    assert clap_supplied(spec, ["--limit", "--sort"],
                         {}) == ["--limit <LIMIT>", "--sort <SORT>"]
    assert clap_supplied(spec, ["--sort", "--limit"],
                         {}) == ["--sort <SORT>", "--limit <LIMIT>"]


def test_clap_usage_appends_env_sourced_options_after_the_typed_ones():
    # An env-sourced option counts as supplied and lands last, which is
    # what the real binary prints with NOTION_API_VERSION set.
    spec = CommandSpec(
        options=(Option(long="--json", type="bool"),
                 Option(long="--notion-version",
                        type="str",
                        metavar="VERSION",
                        env="NOTION_API_VERSION")),
        positional=(Operand(type="str", name="PAGE_ID", required=True), ),
    )
    env = {"NOTION_API_VERSION": "2025-09-03"}
    assert clap_supplied(spec, ["--json"],
                         env) == ["--json", "--notion-version <VERSION>"]
    # Unset, it is simply not supplied.
    assert clap_supplied(spec, ["--json"], {}) == ["--json"]


def test_clap_usage_omits_a_merely_defaulted_option():
    # GNU-style defaults are invisible to clap's usage line: only what
    # the line carried (or an env supplied) is echoed. The parser hands
    # over typed dests precisely so this stays true.
    spec = CommandSpec(options=(Option(long="--limit",
                                       type="int",
                                       default="25"), ),
                       positional=(Operand(type="str",
                                           name="ID",
                                           required=True), ))
    assert clap_supplied(spec, [], {}) == []


def test_clap_exits_two_like_argparse_but_for_its_own_reason():
    msg, code = leaf_refusal(UsageStyle.CLAP, ARGPARSE_MESSAGE, _parsed([]))
    assert msg == ARGPARSE_MESSAGE
    assert code == 2


# Every CLI-tier option that declares `choices` renders through the same
# gnulib ARGMATCH block a coreutils command does, because a leaf parses
# with the ordinary spec machinery. What a CLI adds is the display path
# in place of a command name, and its dialect's exit code. The
# expectation is CHOSEN rather than measured: none of these is a GNU
# program, so there is no host binary to pin the wording against.
_CLI_CHOICE_REFUSALS = [
    ("gh", {
        "token": "t"
    }, "gh issue list --state=x", "gh issue list", "--state", "x",
     ("open", "closed", "all"), ARGPARSE_EXIT),
    ("gh", {
        "token": "t"
    }, "gh pr list --state=x", "gh pr list", "--state", "x",
     ("open", "closed", "merged", "all"), ARGPARSE_EXIT),
    ("hf", {
        "token": "t"
    }, "hf download --repo-type=x owner/repo file", "hf download",
     "--repo-type", "x", ("model", "dataset", "space"), ARGPARSE_EXIT),
    ("hf", {
        "token": "t"
    }, "hf repo create --space_sdk=x owner/repo", "hf repo create",
     "--space_sdk", "x", ("gradio", "streamlit", "docker",
                          "static"), ARGPARSE_EXIT),
    ("himalaya", {
        "imap_host": "h",
        "smtp_host": "h",
        "username": "u",
        "password": "p",
    }, "himalaya message reply --posting-style=x 1", "himalaya message reply",
     "--posting-style", "x", ("top", "bottom"), ARGPARSE_EXIT),
    # git is the one GIT-dialect install, so it is also the one that
    # answers the block with 129 rather than argparse's 2.
    ("git", None, "git status --untracked-files=bogus", "git status",
     "--untracked-files", "bogus", ("no", "normal", "all"), 129),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("name,config,line,path,option,bad,choices,exit_code",
                         _CLI_CHOICE_REFUSALS)
async def test_a_cli_leaf_refuses_a_choice_in_the_argmatch_block(
        name, config, line, path, option, bad, choices, exit_code):
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    ws.register_cli(name, cli_spec_for(name), config=config)
    result = await ws.execute(line)
    valid = "\n".join(f"  - '{c}'" for c in choices)
    assert (await result.materialize_stderr()).decode() == (
        f"{path}: invalid argument '{bad}' for '{option}'\n"
        f"Valid arguments are:\n{valid}\n"
        f"Try '{path} --help' for more information.\n")
    assert result.exit_code == exit_code


# Pinned against git 2.47.3. git's parse-options runs the whole option
# scan first and reports an unrecognized option from it, and only then
# does the command validate a value it did accept, so under the GIT
# dialect an unknown option outranks a bad value WHEREVER the two sit on
# the line -- the opposite of the scan-order rule every coreutils
# command follows. `git status --untracked-files=bogus --bogus` and the
# same two words reversed both answer `unknown option`, and
# `git status --untracked-files=bogus` alone answers the ARGMATCH block
# above. Do not "fix" leaf_refusal to report the first error in line
# order: that reads as consistency and is a divergence from git.
@pytest.mark.asyncio
@pytest.mark.parametrize("line", [
    "git status --untracked-files=bogus --bogus",
    "git status --bogus --untracked-files=bogus",
])
async def test_git_reports_an_unknown_option_over_an_earlier_bad_value(line):
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    ws.register_cli("git", cli_spec_for("git"))
    result = await ws.execute(line)
    assert (await result.materialize_stderr()).decode() == (
        "error: unknown option `bogus'\n")
    assert result.exit_code == 129
