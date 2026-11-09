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

from types import SimpleNamespace

from mirage.commands.cli.cobra import (
    cobra_refusal,
    cobra_usage,
    group_message,
    leaf_message,
    sets_value_flag,
    unknown_command,
)
from mirage.commands.spec.types import Argument, CommandSpec

BOOLEAN = ("true", "false")


def _flag(*names: str, help_text: str) -> Argument:
    return Argument(
        *names,
        nargs="?",
        attached_only=True,
        short_value=False,
        choices=BOOLEAN,
        help=help_text,
    )


LEAF = CommandSpec(
    name="list",
    arguments=(
        Argument("-R", "--repo", help="Select another repository"),
        Argument("--json", metavar="fields", help="Output JSON"),
        Argument(
            "-L", "--limit", type="int", default="30", help="Maximum items"
        ),
        Argument(
            "-s",
            "--state",
            choices=("open", "all"),
            default="open",
            help="Filter by state",
        ),
        Argument("-l", "--label", action="append", help="Filter by label"),
        _flag("-d", "--draft", help_text="Filter by draft"),
        _flag("--confirm", help_text="Deprecated: use --yes instead"),
    ),
)


def test_usage_lists_a_leafs_own_flags_as_pflag_aligns_them():
    assert cobra_usage("gh pr list", LEAF) == (
        "Usage:  gh pr list [flags]\n\n"
        "Flags:\n"
        "  -d, --draft           Filter by draft\n"
        "      --json fields     Output JSON\n"
        "  -l, --label strings   Filter by label\n"
        "  -L, --limit int       Maximum items (default 30)\n"
        '  -s, --state string    Filter by state: {open|all} (default "open")\n'
        "  \n"
    )


def test_a_repo_flag_with_a_value_name_is_the_commands_own():
    node = CommandSpec(
        name="rename",
        arguments=(
            Argument("NAME", metavar="[<new-name>]"),
            Argument("-R", "--repo", metavar="OWNER/REPO", help="Select"),
        ),
    )
    assert cobra_usage("gh repo rename", node) == (
        "Usage:  gh repo rename [<new-name>] [flags]\n\n"
        "Flags:\n"
        "  -R, --repo OWNER/REPO   Select\n"
        "  \n"
    )


def test_a_table_of_long_flags_only_is_dedented():
    node = CommandSpec(
        name="delete", arguments=(_flag("--yes", help_text="Confirm"),)
    )
    assert cobra_usage("gh label delete", node).endswith(
        "Flags:\n  --yes   Confirm\n  \n"
    )


def test_a_leaf_with_no_flags_is_one_line():
    node = CommandSpec(name="version")
    assert cobra_usage("gh version", node) == "Usage:  gh version [flags]\n"


def test_a_group_lists_its_commands_sorted():
    node = CommandSpec(
        name="pr",
        subcommands=(CommandSpec(name="view"), CommandSpec(name="list")),
    )
    assert cobra_usage("gh pr", node) == (
        "Usage:  gh pr <command> [flags]\n\n"
        "Available commands:\n  list\n  view\n\n"
    )


def test_the_root_names_two_slots():
    node = CommandSpec(name="gh", subcommands=(CommandSpec(name="pr"),))
    assert cobra_usage("gh", node).startswith(
        "Usage:  gh <command> <subcommand> [flags]\n"
    )


def test_a_use_line_that_carries_git_flags_omits_flags():
    node = CommandSpec(
        name="clone",
        arguments=(Argument("GIST", metavar="<gist>"),),
    )
    assert cobra_usage("gh gist clone", node) == (
        "Usage:  gh gist clone <gist>\n"
    )


def test_a_refusal_keeps_one_blank_line_before_the_block():
    node = CommandSpec(name="version")
    block = "Usage:  gh version [flags]\n"
    assert cobra_refusal("no", "gh version", node) == f"no\n\n{block}"
    assert cobra_refusal("no\n", "gh version", node) == f"no\n\n{block}"


def _refused(
    **reports: list[str]
    | list[tuple[str, str]]
    | list[tuple[str, str, tuple[str, ...]]],
) -> SimpleNamespace:
    return SimpleNamespace(**reports)


def test_an_unknown_long_flag_drops_its_value():
    parsed = _refused(
        option_error_kinds=["invalid"], invalid_options=["--nope=2"]
    )
    assert leaf_message(parsed, LEAF, ["--nope=2"], "pr list") == (
        "unknown flag: --nope"
    )


def test_an_unknown_short_flag_names_the_rest_of_its_cluster():
    parsed = _refused(option_error_kinds=["invalid"], invalid_options=["x"])
    assert leaf_message(parsed, LEAF, ["-xd"], "pr list") == (
        "unknown shorthand flag: 'x' in -xd"
    )


def test_a_flag_short_of_its_value():
    long = _refused(
        option_error_kinds=["needs_value"], needs_value_options=["--limit"]
    )
    short = _refused(
        option_error_kinds=["needs_value"], needs_value_options=["L"]
    )
    assert leaf_message(long, LEAF, ["--limit"], "pr list") == (
        "flag needs an argument: --limit"
    )
    assert leaf_message(short, LEAF, ["-L"], "pr list") == (
        "flag needs an argument: 'L' in -L"
    )


def test_a_value_is_refused_in_its_types_words():
    number = _refused(
        option_error_kinds=["int"], invalid_int_options=[("--limit", "x")]
    )
    choice = _refused(
        option_error_kinds=["value"],
        invalid_value_options=[("--state", "x", ())],
    )
    switch = _refused(
        option_error_kinds=["value"],
        invalid_value_options=[("--draft", "x", ())],
    )
    assert leaf_message(number, LEAF, [], "pr list") == (
        'invalid argument "x" for "-L, --limit" flag: '
        'strconv.ParseInt: parsing "x": invalid syntax'
    )
    assert leaf_message(choice, LEAF, [], "pr list") == (
        'invalid argument "x" for "-s, --state" flag: '
        "valid values are {open|all}"
    )
    assert leaf_message(switch, LEAF, [], "pr list") == (
        'invalid argument "x" for "-d, --draft" flag: '
        'strconv.ParseBool: parsing "x": invalid syntax'
    )


def test_a_clone_verb_adds_its_hint():
    parsed = _refused(
        option_error_kinds=["invalid"], invalid_options=["--nope"]
    )
    assert leaf_message(parsed, LEAF, [], "repo clone") == (
        "unknown flag: --nope\nSeparate git clone flags with '--'."
    )
    assert leaf_message(parsed, LEAF, [], "repo fork") == (
        "unknown flag: --nope\nSeparate git clone flags with `--`."
    )


def test_a_parse_with_no_option_error_has_no_message():
    parsed = _refused(option_error_kinds=[])
    assert leaf_message(parsed, LEAF, [], "pr list") is None


def test_group_refusals_in_pflags_words():
    assert group_message("unknown option: --x", "--x") == "unknown flag: --x"
    assert group_message("unknown option: -x", None) == (
        "unknown shorthand flag: 'x' in -x"
    )
    assert group_message("error: option '--x' requires a value", None) == (
        "flag needs an argument: --x"
    )
    assert group_message("error: other", None) == "error: other"


def test_an_unknown_command_suggests_a_near_or_longer_name():
    node = CommandSpec(
        name="pr",
        subcommands=(CommandSpec(name="list"), CommandSpec(name="merge")),
    )
    assert unknown_command("lisst", "gh pr", node) == (
        'unknown command "lisst" for "gh pr"\n\nDid you mean this?\n\tlist\n'
    )
    assert unknown_command("zzzzzz", "gh pr", node) == (
        'unknown command "zzzzzz" for "gh pr"'
    )
    assert "\tmerge\n" in unknown_command("mer", "gh pr", node)


def test_sets_value_flag_ignores_switches_and_what_follows_a_dash_dash():
    assert sets_value_flag(LEAF, ["--limit", "3"])
    assert sets_value_flag(LEAF, ["--limit=3"])
    assert sets_value_flag(LEAF, ["-L3"])
    assert not sets_value_flag(LEAF, ["--draft", "a"])
    assert not sets_value_flag(LEAF, ["--", "--limit"])
