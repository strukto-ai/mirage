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

from mirage.commands.cli import CLISpec, walk
from mirage.commands.spec.types import OperandKind, Option


async def _verb(config, paths, *texts, **flags):
    return None


def _tree() -> CLISpec:
    return CLISpec(
        name="gws",
        description="Google Workspace",
        options=(
            Option(short="-C",
                   long="--cwd",
                   value_kind=OperandKind.TEXT,
                   description="run as if started there"),
            Option(short="-v", long="--verbose", count=True),
        ),
        subcommands=(
            CLISpec(name="gmail",
                    description="Gmail messages",
                    options=(Option(long="--account",
                                    value_kind=OperandKind.TEXT,
                                    default="primary",
                                    choices=("primary", "work")), ),
                    subcommands=(
                        CLISpec(name="send", fn=_verb, write=True),
                        CLISpec(name="list", fn=_verb),
                    )),
            CLISpec(name="docs",
                    description="Google Docs",
                    subcommands=(CLISpec(name="cat", fn=_verb), )),
        ),
    )


def test_resolves_a_leaf_and_keeps_its_argv():
    result = walk("gws", _tree(), ["gmail", "send", "-t", "a@x.com", "hi"])
    assert result.leaf is not None
    assert result.leaf.write is True
    assert result.path == ("gmail", "send")
    assert result.argv == ("-t", "a@x.com", "hi")
    assert result.exit_code == 0


def test_group_options_collect_per_level():
    result = walk("gws", _tree(), [
        "-C", "/tmp", "-vv", "gmail", "--account=work", "send", "x"
    ])
    assert result.leaf is not None
    assert result.group_flags == {
        "--cwd": "/tmp",
        "--verbose": 2,
        "--account": "work",
    }
    assert result.argv == ("x", )


def test_group_defaults_land_as_if_typed():
    result = walk("gws", _tree(), ["gmail", "list"])
    assert result.leaf is not None
    assert result.group_flags == {"--account": "primary"}


def test_bare_root_prints_usage_to_stdout_exit_1():
    result = walk("gws", _tree(), [])
    assert result.leaf is None
    assert result.stream == "stdout"
    assert result.exit_code == 1
    assert result.output.startswith(
        b"usage: gws [<options>] <command> [<args>]")
    assert b"Commands:" in result.output


def test_help_prints_the_same_usage_exit_0():
    bare = walk("gws", _tree(), [])
    helped = walk("gws", _tree(), ["--help"])
    assert helped.exit_code == 0
    assert helped.stream == "stdout"
    assert helped.output == bare.output


def test_nested_group_help_names_the_path():
    result = walk("gws", _tree(), ["gmail", "--help"])
    assert result.exit_code == 0
    assert result.output.startswith(
        b"usage: gws gmail [<options>] <command> [<args>]")


def test_unknown_verb_matches_git_wording():
    result = walk("gws", _tree(), ["bogus"])
    assert result.stream == "stderr"
    assert result.exit_code == 1
    assert result.output == (b"gws: 'bogus' is not a gws command. "
                             b"See 'gws --help'.\n")


def test_unknown_nested_verb_names_the_group_path():
    result = walk("gws", _tree(), ["gmail", "bogus"])
    assert result.output == (b"gws: 'bogus' is not a gws gmail command. "
                             b"See 'gws gmail --help'.\n")


def test_installed_head_renders_in_messages():
    result = walk("gws-work", _tree(), ["bogus"])
    assert result.output == (b"gws-work: 'bogus' is not a gws-work command. "
                             b"See 'gws-work --help'.\n")


def test_unknown_group_option_exits_129_with_usage():
    result = walk("gws", _tree(), ["--zzz", "gmail"])
    assert result.stream == "stderr"
    assert result.exit_code == 129
    assert result.output.startswith(b"unknown option: --zzz\n\nusage: gws ")


def test_starved_group_value_exits_129():
    result = walk("gws", _tree(), ["--cwd"])
    assert result.exit_code == 129
    assert result.output.startswith(
        b"error: option '--cwd' requires a value")


def test_bool_long_with_value_refused():
    result = walk("gws", _tree(), ["--verbose=3", "gmail", "list"])
    assert result.exit_code == 129
    assert result.output.startswith(
        b"error: option '--verbose' takes no value")


def test_invalid_group_choice_exits_129():
    result = walk("gws", _tree(), ["gmail", "--account=other", "list"])
    assert result.exit_code == 129
    assert result.output.startswith(
        b"error: invalid argument 'other' for '--account'")


def test_attached_short_value_and_cluster():
    result = walk("gws", _tree(), ["-C/tmp", "gmail", "send"])
    assert result.leaf is not None
    assert result.group_flags["--cwd"] == "/tmp"
    clustered = walk("gws", _tree(), ["-vvC", "/tmp", "gmail", "send"])
    assert clustered.leaf is not None
    assert clustered.group_flags == {
        "--verbose": 2,
        "--cwd": "/tmp",
        "--account": "primary",
    }


def test_double_dash_ends_group_options():
    result = walk("gws", _tree(), ["--", "gmail", "send"])
    assert result.leaf is not None
    assert result.path == ("gmail", "send")
    helped = walk("gws", _tree(), ["--", "--help"])
    assert helped.leaf is None
    assert b"is not a gws command" in helped.output


def test_leaf_root_passes_argv_through():
    single = CLISpec(name="hello", fn=_verb)
    result = walk("hello", single, ["--help", "-x", "arg"])
    assert result.leaf is single
    assert result.path == ()
    assert result.argv == ("--help", "-x", "arg")


def test_required_group_option_missing_exits_129():
    tree = CLISpec(
        name="tool",
        options=(Option(long="--token",
                        value_kind=OperandKind.TEXT,
                        required=True), ),
        subcommands=(CLISpec(name="run", fn=_verb), ),
    )
    result = walk("tool", tree, ["run"])
    assert result.exit_code == 129
    assert result.output.startswith(b"error: option '--token' is required")
    ok = walk("tool", tree, ["--token", "t", "run"])
    assert ok.leaf is not None
    assert ok.group_flags == {"--token": "t"}
