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

from dataclasses import replace

import pytest

from mirage.commands.cli import CLI, CLIHandler, walk
from mirage.commands.cli.walk import (
    env_names,
    find_child,
    find_node,
    invoked_env_names,
    node_help,
    owns_argv,
    supplied_env_names,
)
from mirage.commands.spec.types import Argument, CommandSpec, UsageStyle
from mirage.runtime.types import ScriptSource
from mirage.types import PathSpec


async def _verb(config, paths, *texts, **flags):
    return None


def _tree() -> CommandSpec:
    return CommandSpec(
        name="gws",
        description="Google Workspace",
        subcommands=(
            CommandSpec(
                name="gmail",
                description="Gmail messages",
                subcommands=(
                    CommandSpec(name="send"),
                    CommandSpec(name="list"),
                ),
                arguments=(
                    Argument(
                        "--account",
                        default="primary",
                        choices=("primary", "work"),
                    ),
                ),
            ),
            CommandSpec(
                name="docs",
                description="Google Docs",
                subcommands=(CommandSpec(name="cat"),),
            ),
        ),
        arguments=(
            Argument("-C", "--cwd", help="run as if started there"),
            Argument("-v", "--verbose", action="count"),
        ),
    )


def test_resolves_a_leaf_and_keeps_its_argv():
    result = walk("gws", _tree(), ["gmail", "send", "-t", "a@x.com", "hi"])
    assert result.leaf is not None
    assert result.leaf.name == "send"
    assert result.path == ("gmail", "send")
    assert result.argv == ("-t", "a@x.com", "hi")
    assert result.exit_code == 0


def test_group_options_collect_per_level():
    result = walk(
        "gws",
        _tree(),
        ["-C", "/tmp", "-vv", "gmail", "--account=work", "send", "x"],
    )
    assert result.leaf is not None
    assert result.group_flags == {
        "--cwd": "/tmp",
        "--verbose": 2,
        "--account": "work",
    }
    assert result.argv == ("x",)


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
        b"usage: gws [-C CWD] [-v] [-h] {gmail,docs} ..."
    )
    assert b"commands:" in result.output


@pytest.mark.parametrize("style", [UsageStyle.ARGPARSE, UsageStyle.COBRA])
@pytest.mark.parametrize("switch", ["--help", "-h"])
def test_help_prints_the_same_usage_exit_0(style, switch):
    tree = replace(_tree(), usage_style=style)
    bare = walk("gws", tree, [])
    helped = walk("gws", tree, [switch])
    assert helped.exit_code == 0
    assert helped.stream == "stdout"
    assert helped.output == bare.output


def test_nested_group_help_names_the_path():
    result = walk("gws", _tree(), ["gmail", "--help"])
    assert result.exit_code == 0
    assert result.output.startswith(
        b"usage: gws gmail [--account {primary,work}] [-h] {send,list} ..."
    )


def test_unknown_verb_matches_git_wording():
    result = walk("gws", _tree(), ["bogus"])
    assert result.stream == "stderr"
    assert result.exit_code == 1
    assert result.output == (
        b"gws: 'bogus' is not a gws command. See 'gws --help'.\n"
    )


def test_unknown_nested_verb_names_the_group_path():
    result = walk("gws", _tree(), ["gmail", "bogus"])
    assert result.output == (
        b"gws: 'bogus' is not a gws gmail command. See 'gws gmail --help'.\n"
    )


def test_installed_head_renders_in_messages():
    result = walk("gws-work", _tree(), ["bogus"])
    assert result.output == (
        b"gws-work: 'bogus' is not a gws-work command. "
        b"See 'gws-work --help'.\n"
    )


def test_unknown_group_option_exits_129_with_usage():
    result = walk("gws", _tree(), ["--zzz", "gmail"])
    assert result.stream == "stderr"
    assert result.exit_code == 129
    assert result.output.startswith(b"unknown option: --zzz\n\nusage: gws")


def test_a_clap_group_refusal_uses_claps_words_and_exit():
    # Probed against ntn 0.21.9: `ntn --bogus` is exit 2, one usage line
    # rather than git's whole help page, and a footer. The dialect is the
    # root's at every level, so a group cannot answer 129 while its own
    # leaves answer 2.
    tree = replace(_tree(), usage_style=UsageStyle.CLAP)
    result = walk("gws", tree, ["--zzz", "gmail"])
    assert result.stream == "stderr"
    assert result.exit_code == 2
    assert result.output.decode() == (
        "error: unexpected argument '--zzz' found\n\n"
        "Usage: gws [OPTIONS] <COMMAND>\n\n"
        "For more information, try '--help'.\n"
    )


def test_a_clap_group_refusal_names_a_short_token_the_same_way():
    # clap has one wording for long and short alike, unlike git's
    # option/switch split.
    tree = replace(_tree(), usage_style=UsageStyle.CLAP)
    result = walk("gws", tree, ["-Z"])
    assert result.exit_code == 2
    assert result.output.decode().splitlines()[0] == (
        "error: unexpected argument '-Z' found"
    )


def test_starved_group_value_exits_129():
    result = walk("gws", _tree(), ["--cwd"])
    assert result.exit_code == 129
    assert result.output.startswith(b"error: option '--cwd' requires a value")


def test_bool_long_with_value_refused():
    result = walk("gws", _tree(), ["--verbose=3", "gmail", "list"])
    assert result.exit_code == 129
    assert result.output.startswith(
        b"error: option '--verbose' takes no value"
    )


def test_invalid_group_choice_exits_129():
    result = walk("gws", _tree(), ["gmail", "--account=other", "list"])
    assert result.exit_code == 129
    assert result.output.startswith(
        b"error: invalid argument 'other' for '--account'"
    )


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
    single = CommandSpec(name="hello")
    result = walk("hello", single, ["--help", "-x", "arg"])
    assert result.leaf is single
    assert result.path == ()
    assert result.argv == ("--help", "-x", "arg")


def test_required_group_option_missing_exits_129():
    tree = CommandSpec(
        name="tool",
        subcommands=(CommandSpec(name="run"),),
        arguments=(Argument("--token", required=True),),
    )
    result = walk("tool", tree, ["run"])
    assert result.exit_code == 129
    assert result.output.startswith(b"error: option '--token' is required")
    ok = walk("tool", tree, ["--token", "t", "run"])
    assert ok.leaf is not None
    assert ok.group_flags == {"--token": "t"}


def test_group_help_lists_the_injected_help_flag():
    result = walk("gws", _tree(), ["--help"])
    assert b"-h, --help" in result.output
    assert b"Show this help and exit" in result.output


def test_optional_value_long_at_group_level():
    tree = CommandSpec(
        name="tool",
        subcommands=(CommandSpec(name="run"),),
        arguments=(Argument("--color", nargs="?", attached_only=True),),
    )
    attached = walk("tool", tree, ["--color=auto", "run"])
    assert attached.leaf is not None
    assert attached.group_flags == {"--color": "auto"}
    bare = walk("tool", tree, ["--color", "run"])
    assert bare.leaf is not None
    assert bare.group_flags == {"--color": True}


def test_multichar_short_at_group_level():
    tree = CommandSpec(
        name="tool",
        subcommands=(CommandSpec(name="run"),),
        arguments=(Argument("-name"),),
    )
    detached = walk("tool", tree, ["-name", "foo", "run"])
    assert detached.leaf is not None
    assert detached.group_flags == {"-name": "foo"}
    attached = walk("tool", tree, ["-namefoo", "run"])
    assert attached.leaf is not None
    assert attached.group_flags == {"-name": "foo"}
    starved = walk("tool", tree, ["-name"])
    assert starved.exit_code == 129
    assert starved.output.startswith(b"error: option '-name' requires a value")


def test_alias_resolves_to_the_canonical_verb():
    tree = CommandSpec(
        name="tool",
        subcommands=(
            CommandSpec(
                name="checkout", aliases=("co",), description="Switch branches"
            ),
        ),
    )
    result = walk("tool", tree, ["co", "x"])
    assert result.leaf is not None
    assert result.path == ("checkout",)
    assert result.argv == ("x",)


def test_alias_renders_beside_the_canonical_name():
    tree = CommandSpec(
        name="tool",
        subcommands=(
            CommandSpec(
                name="checkout",
                aliases=("co", "cout"),
                description="Switch branches",
            ),
        ),
    )
    listing = walk("tool", tree, [])
    assert b"  checkout (co, cout)  Switch branches" in listing.output


def test_group_long_prefix_expands_like_git():
    result = walk("gws", _tree(), ["--verb", "--verb", "gmail", "send"])
    assert result.leaf is not None
    assert result.group_flags["--verbose"] == 2


def test_group_ambiguous_prefix_uses_git_wording():
    tree = CommandSpec(
        name="tool",
        subcommands=(CommandSpec(name="run"),),
        arguments=(
            Argument("--context"),
            Argument("--count", action="store_true"),
        ),
    )
    result = walk("tool", tree, ["--co", "run"])
    assert result.exit_code == 129
    assert result.output.startswith(
        b"error: ambiguous option: co (could be --context or --count)"
    )


def test_help_prefix_reaches_the_injected_help():
    full = walk("gws", _tree(), ["--help"])
    abbreviated = walk("gws", _tree(), ["--hel"])
    assert abbreviated.exit_code == 0
    assert abbreviated.output == full.output


def test_int_typed_group_option_uses_git_wording():
    tree = CommandSpec(
        name="tool",
        subcommands=(CommandSpec(name="run"),),
        arguments=(Argument("--depth", type="int"),),
    )
    bad = walk("tool", tree, ["--depth", "x", "run"])
    assert bad.exit_code == 129
    assert bad.output.startswith(
        b"error: option '--depth' expects a numerical value"
    )
    ok = walk("tool", tree, ["--depth", "-3", "run"])
    assert ok.leaf is not None
    assert ok.group_flags == {"--depth": "-3"}


def test_float_typed_group_option_uses_git_wording():
    tree = CommandSpec(
        name="tool",
        subcommands=(CommandSpec(name="run"),),
        arguments=(Argument("--ratio", type="float"),),
    )
    bad = walk("tool", tree, ["--ratio", "5x", "run"])
    assert bad.exit_code == 129
    assert bad.output.startswith(
        b"error: option '--ratio' expects a numerical value"
    )
    ok = walk("tool", tree, ["--ratio", "2.5", "run"])
    assert ok.leaf is not None
    assert ok.group_flags == {"--ratio": "2.5"}


def test_find_child_matches_name_or_alias():
    tree = CommandSpec(
        name="gws",
        subcommands=(CommandSpec(name="checkout", aliases=("co",)),),
    )
    assert find_child(tree, "checkout").name == "checkout"
    assert find_child(tree, "co").name == "checkout"
    assert find_child(tree, "nope") is None


def test_find_node_returns_the_node_and_its_canonical_path():
    node, path = find_node(_tree(), ["gmail", "send"])
    assert node.name == "send"
    assert path == ("gmail", "send")


def test_find_node_with_no_verbs_is_the_root():
    tree = _tree()
    node, path = find_node(tree, [])
    assert node is tree
    assert path == ()


def test_find_node_misses_on_an_unknown_verb():
    assert find_node(_tree(), ["gmail", "bogus"]) is None
    assert find_node(_tree(), ["bogus"]) is None


def test_script_root_terminates_the_walk_with_argv_verbatim():
    # A script node is a terminal leaf like an fn node: the walk hands
    # back every token so the program can re-parse argv natively.
    spec = CommandSpec(name="pager")
    result = walk("pager", spec, ["--frobnicate", "report.txt"])
    assert result.leaf is spec
    assert result.path == ()
    assert result.argv == ("--frobnicate", "report.txt")
    assert result.exit_code == 0


def test_owns_argv_only_for_a_grammarless_script_root():
    source = ScriptSource("print('hi')")
    assert owns_argv(CLI(CommandSpec(name="pager"), script=source))
    declared = CommandSpec(
        name="pager", arguments=(Argument("--width", type="int"),)
    )
    assert not owns_argv(CLI(declared, script=source))
    assert not owns_argv(
        CLI(CommandSpec(name="prog"), handlers={"": CLIHandler(_verb)})
    )


def test_manual_of_a_grammarless_script_omits_the_help_row():
    # man renders from the spec, so it must not advertise a --help the
    # program answers itself.
    text = node_help(
        "pager",
        CLI(CommandSpec(name="pager"), script=ScriptSource("print(1)")).spec,
    )
    assert text.startswith("usage: pager\n")
    assert "--help" not in text


def test_group_help_lists_a_child_that_declares_its_own_help():
    # The listed group is grammar only; a rebuilt CommandSpec would refuse
    # the added --help as colliding with the child's own.
    child = CommandSpec(
        name="run", arguments=(Argument("--help", action="store_true"),)
    )
    tree = CommandSpec(name="tool", subcommands=(child,))
    assert "run" in node_help("tool", tree)


def test_path_typed_group_option_resolves_against_cwd():
    # A group option declared "path" has to mean what it means on a
    # leaf, or the type is a lie at exactly one level of the tree.
    tree = CommandSpec(
        name="tool",
        subcommands=(CommandSpec(name="run"),),
        arguments=(Argument("-C", type="path"),),
    )
    relative = walk("tool", tree, ["-C", "build", "run"], "/repo/src")
    assert relative.group_flags == {
        "-C": PathSpec.from_str_path("build", cwd="/repo/src")
    }
    absolute = walk("tool", tree, ["-C", "/other", "run"], "/repo/src")
    assert absolute.group_flags == {"-C": PathSpec.from_str_path("/other")}


def test_path_typed_group_default_lands_as_the_cwd():
    tree = CommandSpec(
        name="tool",
        subcommands=(CommandSpec(name="run"),),
        arguments=(Argument("-C", type="path", default="."),),
    )
    assert walk("tool", tree, ["run"], "/repo/src").group_flags == {
        "-C": PathSpec.from_str_path(".", cwd="/repo/src")
    }


def test_repeated_path_group_option_resolves_every_value():
    tree = CommandSpec(
        name="tool",
        subcommands=(CommandSpec(name="run"),),
        arguments=(Argument("--dir", type="path", action="append"),),
    )
    result = walk("tool", tree, ["--dir", "a", "--dir", "/b", "run"], "/w")
    assert result.group_flags == {
        "--dir": [
            PathSpec.from_str_path("a", cwd="/w"),
            PathSpec.from_str_path("/b"),
        ]
    }


def _env_tree() -> CommandSpec:
    return CommandSpec(
        name="tool",
        subcommands=(
            CommandSpec(
                name="alpha",
                subcommands=(
                    CommandSpec(
                        name="deep",
                        arguments=(Argument("--d", env="DEEP_T"),),
                    ),
                ),
                arguments=(Argument("--a", env="ALPHA_T"),),
            ),
            CommandSpec(
                name="beta",
                aliases=("b",),
                arguments=(Argument("--b", env="BETA_T"),),
            ),
        ),
        arguments=(Argument("--token", env="ROOT_T"),),
    )


def test_env_names_covers_the_whole_tree():
    assert env_names(_env_tree()) == {"ROOT_T", "ALPHA_T", "DEEP_T", "BETA_T"}


def test_invoked_env_names_prunes_to_the_selected_path():
    tree = _env_tree()
    assert invoked_env_names(tree, frozenset()) == {"ROOT_T"}
    assert invoked_env_names(tree, frozenset({"alpha"})) == {
        "ROOT_T",
        "ALPHA_T",
    }
    assert invoked_env_names(tree, frozenset({"alpha", "deep"})) == {
        "ROOT_T",
        "ALPHA_T",
        "DEEP_T",
    }
    # A verb word selects its node wherever it sits in the line, and an
    # alias selects the same node its canonical name does.
    assert invoked_env_names(tree, frozenset({"b"})) == {"ROOT_T", "BETA_T"}
    # None means a word only the runtime can spell: the whole tree is
    # the only safe answer.
    assert invoked_env_names(tree, None) == env_names(tree)


def test_group_env_fills_at_its_own_level():
    result = walk(
        "tool",
        _env_tree(),
        ["alpha", "deep"],
        "/",
        {"ROOT_T": "rv", "ALPHA_T": "av"},
    )
    assert result.leaf is not None
    assert result.group_flags == {"--token": "rv", "--a": "av"}


def test_group_env_yields_to_the_typed_value():
    result = walk(
        "tool",
        _env_tree(),
        ["--token", "typed", "alpha", "deep"],
        "/",
        {"ROOT_T": "rv"},
    )
    assert result.leaf is not None
    assert result.group_flags == {"--token": "typed"}


def _shared_env_tree() -> CommandSpec:
    return CommandSpec(
        name="tool",
        subcommands=(
            CommandSpec(
                name="alpha",
                arguments=(Argument("--a", env="SHARED"),),
            ),
        ),
        arguments=(Argument("--token", env="SHARED"),),
    )


def test_supplied_env_names_tracks_destinations_not_names():
    tree = _shared_env_tree()
    # One reader supplied: the unsupplied one still falls back to the
    # variable, so it stays a read.
    assert supplied_env_names(tree, ["--token", "x", "alpha"]) == frozenset()
    # Every reader on the path supplied: nothing consults it.
    assert supplied_env_names(tree, ["--token", "x", "alpha", "--a", "y"]) == {
        "SHARED"
    }


def test_supplied_env_names_double_dash_keeps_descendants_readable():
    # The walk keeps descending after --, so a variable a subcommand
    # can still read is never claimed ...
    assert (
        supplied_env_names(_shared_env_tree(), ["--token", "x", "--"])
        == frozenset()
    )
    # ... while one with no reader below the group stays claimed.
    assert supplied_env_names(_env_tree(), ["--token", "x", "--"]) == {
        "ROOT_T"
    }


def test_option_shaped_alias_uses_the_declared_leaf():
    leaf = CommandSpec(name="version", aliases=("--version", "-v"))
    spec = CommandSpec(
        name="tool",
        subcommands=(leaf,),
        arguments=(Argument("-C", type="path", default="."),),
    )
    result = walk("tool", spec, ["--version"], cwd="/work")
    assert result.leaf is leaf
    assert result.path == ("version",)
    assert result.group_flags["-C"].virtual == "/work"
    assert result.argv == ()
    # A real option keeps its meaning even if a child also declares that alias.
    spec = replace(spec, arguments=(Argument("-v", action="store_true"),))
    result = walk("tool", spec, ["-v", "version"])
    assert result.leaf is leaf
    assert result.group_flags["-v"] is True


def test_option_shaped_alias_is_an_operand_after_double_dash():
    leaf = CommandSpec(name="version", aliases=("--version", "-v"))
    spec = CommandSpec(name="tool", subcommands=(leaf,))
    for word in ("--version", "-v"):
        result = walk("tool", spec, ["--", word])
        assert result.leaf is None
        assert result.exit_code == 1
        assert (
            result.output
            == f"tool: '{word}' is not a tool command. See 'tool --help'.\n".encode()
        )
    assert walk("tool", spec, ["--", "version"]).leaf is leaf


def test_git_root_refuses_double_dash_like_an_unknown_option():
    leaf = CommandSpec(name="status")
    inner = CommandSpec(name="remote", subcommands=(leaf,))
    spec = CommandSpec(
        name="git", usage_style=UsageStyle.GIT, subcommands=(leaf, inner)
    )
    for argv in (["--", "status"], ["--"]):
        result = walk("git", spec, argv)
        assert result.leaf is None
        assert result.exit_code == 129
        assert result.output.startswith(b"unknown option: --\n")
    assert walk("git", spec, ["remote", "--", "status"]).leaf is leaf
    assert (
        walk(
            "git",
            replace(spec, usage_style=UsageStyle.ARGPARSE),
            ["--", "status"],
        ).leaf
        is leaf
    )


@pytest.mark.parametrize(
    "argv,expected",
    [
        (["-C", "/repo", "-C", "docs"], "/repo/docs"),
        (["-C", "/repo", "-C", "/other"], "/other"),
        (["-C", "a", "-C", "../b"], "/work/b"),
        (["-C", "", "-C", "docs"], "/work/docs"),
        (["-C", "docs", "-C", ""], "/work/docs"),
        ([], "/work"),
    ],
)
def test_an_operand_base_moves_like_a_chdir(argv, expected):
    tree = CommandSpec(
        name="git",
        operand_base="-C",
        subcommands=(CommandSpec(name="status"),),
        arguments=(Argument("-C", type="path", default="."),),
    )
    result = walk("git", tree, [*argv, "status"], cwd="/work")
    assert result.group_flags["-C"].virtual == expected


ARITY_TREE = CommandSpec(
    name="tool",
    arguments=(
        Argument("-v", action="store_true"),
        Argument("--output", nargs=1, type="path", env="OUTPUT"),
        Argument("-p", "--point", nargs=2, env="POINT"),
        Argument("-c", "--color", nargs="?"),
        Argument("-g", "--gnu", nargs="?", attached_only=True),
        Argument(
            "--rawfile",
            nargs=2,
            action="extend",
            type="path",
            value_types=("str", "path"),
        ),
    ),
    subcommands=(
        CommandSpec(name="run", arguments=(Argument("--token", env="TOKEN"),)),
    ),
)


@pytest.mark.parametrize(
    "words",
    [
        ["--point", "1", "2"],
        ["-p", "1", "2"],
        ["-p1", "2"],
        ["-vp", "1", "2"],
        ["-vp1", "2"],
    ],
)
def test_group_fixed_nargs_consumes_all_values_before_the_subcommand(words):
    result = walk("tool", ARITY_TREE, [*words, "run"])
    assert result.path == ("run",)
    assert result.group_flags["--point"] == ["1", "2"]
    assert result.argv == ()


def test_group_fixed_nargs_store_replaces_and_extend_accumulates():
    points = ["--point", "1", "2", "--point", "3", "4"]
    files = ["--rawfile", "a", "b", "--rawfile", "c", "d"]
    result = walk("tool", ARITY_TREE, [*points, *files, "run"], cwd="/work")
    assert result.group_flags["--point"] == ["3", "4"]
    values = result.group_flags["--rawfile"]
    assert values[::2] == ["a", "c"]
    assert all(isinstance(value, PathSpec) for value in values[1::2])
    assert [value.virtual for value in values[1::2]] == ["/work/b", "/work/d"]
    refused = walk("tool", ARITY_TREE, ["--point", "1"])
    assert refused.exit_code != 0
    assert b"requires a value" in refused.output
    for word, path in (
        ("--output=x", "/work/x"),
        ("--out=x", "/work/x"),
        ("--output=", "/work"),
    ):
        attached = walk("tool", ARITY_TREE, [word, "run"], cwd="/work")
        assert attached.path == ("run",)
        assert [
            value.virtual for value in attached.group_flags["--output"]
        ] == [path]
        assert attached.argv == ()
    assert walk("tool", ARITY_TREE, ["--point=1", "2", "run"]).exit_code != 0


@pytest.mark.parametrize(
    "words, flags",
    [
        (["--color", "auto"], {"--color": "auto"}),
        (["-c", "auto"], {"--color": "auto"}),
        (["-vc", "auto"], {"-v": True, "--color": "auto"}),
        (["-vc", "--"], {"-v": True, "--color": True}),
        (["--gnu"], {"--gnu": True}),
        (["-vgauto"], {"-v": True, "--gnu": "auto"}),
        (["-vg"], {"-v": True, "--gnu": True}),
    ],
)
def test_group_optional_values_consume_detached_values(words, flags):
    result = walk("tool", ARITY_TREE, [*words, "run"])
    assert result.path == ("run",)
    assert result.group_flags == flags


def test_supplied_environment_scan_skips_the_complete_group_argument():
    assert supplied_env_names(
        ARITY_TREE, ["--point", "x", "y", "run", "--token", "secret"]
    ) == frozenset({"POINT", "TOKEN"})
    assert supplied_env_names(
        ARITY_TREE, ["--output=x", "run", "--token", "secret"]
    ) == frozenset({"OUTPUT", "TOKEN"})


def test_group_help_and_abbreviation_settings_apply_to_the_whole_node():
    tree = CommandSpec(
        name="tool",
        arguments=(Argument("--verbose", action="store_true"),),
        subcommands=(CommandSpec(name="run"),),
        allow_abbrev=False,
        add_help=False,
    )
    for words in (["--verb", "run"], ["--help"], ["-h"]):
        result = walk("tool", tree, words)
        assert result.exit_code != 0
        assert b"unknown option" in result.output
    assert "--help" not in node_help("tool", tree)
