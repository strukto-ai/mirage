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

from mirage.commands.cli.refusal import (ARGPARSE_EXIT, git_unknown_option,
                                         leaf_refusal)
from mirage.commands.cli.types import UsageStyle
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
