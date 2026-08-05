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
from mirage.commands.cli.walk import (find_child, find_node, node_help,
                                      owns_argv)
from mirage.commands.spec.types import Option
from mirage.runtime.types import ScriptSource


async def _verb(config, paths, *texts, **flags):
    return None


def _tree() -> CLISpec:
    return CLISpec(
        name="gws",
        description="Google Workspace",
        options=(
            Option(short="-C",
                   long="--cwd",
                   type="str",
                   description="run as if started there"),
            Option(short="-v", long="--verbose", count=True),
        ),
        subcommands=(
            CLISpec(name="gmail",
                    description="Gmail messages",
                    options=(Option(long="--account",
                                    type="str",
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
    result = walk(
        "gws", _tree(),
        ["-C", "/tmp", "-vv", "gmail", "--account=work", "send", "x"])
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
        b"gws: Google Workspace\n\nUsage: gws [flags] <command> [<args>]")
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
        b"gws gmail: Gmail messages\n\n"
        b"Usage: gws gmail [flags] <command> [<args>]")


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
    assert result.output.startswith(
        b"unknown option: --zzz\n\ngws: Google Workspace")


def test_starved_group_value_exits_129():
    result = walk("gws", _tree(), ["--cwd"])
    assert result.exit_code == 129
    assert result.output.startswith(b"error: option '--cwd' requires a value")


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
        options=(Option(long="--token", type="str", required=True), ),
        subcommands=(CLISpec(name="run", fn=_verb), ),
    )
    result = walk("tool", tree, ["run"])
    assert result.exit_code == 129
    assert result.output.startswith(b"error: option '--token' is required")
    ok = walk("tool", tree, ["--token", "t", "run"])
    assert ok.leaf is not None
    assert ok.group_flags == {"--token": "t"}


def test_group_help_lists_the_injected_help_flag():
    result = walk("gws", _tree(), ["--help"])
    assert b"\n  --help" in result.output
    assert b"Show this help and exit" in result.output


def test_optional_value_long_at_group_level():
    tree = CLISpec(
        name="tool",
        options=(Option(long="--color", type="str", value_optional=True), ),
        subcommands=(CLISpec(name="run", fn=_verb), ),
    )
    attached = walk("tool", tree, ["--color=auto", "run"])
    assert attached.leaf is not None
    assert attached.group_flags == {"--color": "auto"}
    bare = walk("tool", tree, ["--color", "run"])
    assert bare.leaf is not None
    assert bare.group_flags == {"--color": True}


def test_multichar_short_at_group_level():
    tree = CLISpec(
        name="tool",
        options=(Option(short="-name", type="str"), ),
        subcommands=(CLISpec(name="run", fn=_verb), ),
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
    tree = CLISpec(
        name="tool",
        subcommands=(CLISpec(name="checkout",
                             aliases=("co", ),
                             description="Switch branches",
                             fn=_verb), ),
    )
    result = walk("tool", tree, ["co", "x"])
    assert result.leaf is not None
    assert result.path == ("checkout", )
    assert result.argv == ("x", )


def test_alias_renders_beside_the_canonical_name():
    tree = CLISpec(
        name="tool",
        subcommands=(CLISpec(name="checkout",
                             aliases=("co", "cout"),
                             description="Switch branches",
                             fn=_verb), ),
    )
    listing = walk("tool", tree, [])
    assert b"  checkout (co, cout)  Switch branches" in listing.output


def test_group_long_prefix_expands_like_git():
    result = walk("gws", _tree(), ["--verb", "--verb", "gmail", "send"])
    assert result.leaf is not None
    assert result.group_flags["--verbose"] == 2


def test_group_ambiguous_prefix_uses_git_wording():
    tree = CLISpec(
        name="tool",
        options=(Option(long="--context", type="str"), Option(long="--count")),
        subcommands=(CLISpec(name="run", fn=_verb), ),
    )
    result = walk("tool", tree, ["--co", "run"])
    assert result.exit_code == 129
    assert result.output.startswith(
        b"error: ambiguous option: co (could be --context or --count)")


def test_help_prefix_reaches_the_injected_help():
    full = walk("gws", _tree(), ["--help"])
    abbreviated = walk("gws", _tree(), ["--hel"])
    assert abbreviated.exit_code == 0
    assert abbreviated.output == full.output


def test_int_typed_group_option_uses_git_wording():
    tree = CLISpec(
        name="tool",
        options=(Option(long="--depth", type="int"), ),
        subcommands=(CLISpec(name="run", fn=_verb), ),
    )
    bad = walk("tool", tree, ["--depth", "x", "run"])
    assert bad.exit_code == 129
    assert bad.output.startswith(
        b"error: option '--depth' expects a numerical value")
    ok = walk("tool", tree, ["--depth", "-3", "run"])
    assert ok.leaf is not None
    assert ok.group_flags == {"--depth": "-3"}


def test_float_typed_group_option_uses_git_wording():
    tree = CLISpec(
        name="tool",
        options=(Option(long="--ratio", type="float"), ),
        subcommands=(CLISpec(name="run", fn=_verb), ),
    )
    bad = walk("tool", tree, ["--ratio", "5x", "run"])
    assert bad.exit_code == 129
    assert bad.output.startswith(
        b"error: option '--ratio' expects a numerical value")
    ok = walk("tool", tree, ["--ratio", "2.5", "run"])
    assert ok.leaf is not None
    assert ok.group_flags == {"--ratio": "2.5"}


def test_find_child_matches_name_or_alias():
    tree = CLISpec(name="gws",
                   subcommands=(CLISpec(name="checkout",
                                        aliases=("co", ),
                                        fn=_verb), ))
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
    spec = CLISpec(name="pager", script=ScriptSource("print('hi')"))
    result = walk("pager", spec, ["--frobnicate", "report.txt"])
    assert result.leaf is spec
    assert result.path == ()
    assert result.argv == ("--frobnicate", "report.txt")
    assert result.exit_code == 0


def test_owns_argv_only_for_a_grammarless_script_root():
    source = ScriptSource("print('hi')")
    assert owns_argv(CLISpec(name="pager", script=source))
    declared = CLISpec(name="pager",
                       script=source,
                       options=(Option(long="--width", type="int"), ))
    assert not owns_argv(declared)
    assert not owns_argv(CLISpec(name="prog", fn=_verb))


def test_manual_of_a_grammarless_script_omits_the_help_row():
    # man renders from the spec, so it must not advertise a --help the
    # program answers itself.
    text = node_help("pager",
                     CLISpec(name="pager", script=ScriptSource("print(1)")))
    assert text.startswith("pager\n")
    assert "--help" not in text


def test_path_typed_group_option_resolves_against_cwd():
    # A group option declared "path" has to mean what it means on a
    # leaf, or the type is a lie at exactly one level of the tree.
    tree = CLISpec(
        name="tool",
        options=(Option(short="-C", type="path"), ),
        subcommands=(CLISpec(name="run", fn=_verb), ),
    )
    relative = walk("tool", tree, ["-C", "build", "run"], "/repo/src")
    assert relative.group_flags == {"-C": "/repo/src/build"}
    absolute = walk("tool", tree, ["-C", "/other", "run"], "/repo/src")
    assert absolute.group_flags == {"-C": "/other"}


def test_path_typed_group_default_lands_as_the_cwd():
    tree = CLISpec(
        name="tool",
        options=(Option(short="-C", type="path", default="."), ),
        subcommands=(CLISpec(name="run", fn=_verb), ),
    )
    assert walk("tool", tree, ["run"], "/repo/src").group_flags == {
        "-C": "/repo/src"
    }


def test_repeated_path_group_option_resolves_every_value():
    tree = CLISpec(
        name="tool",
        options=(Option(long="--dir", type="path", multiple=True), ),
        subcommands=(CLISpec(name="run", fn=_verb), ),
    )
    result = walk("tool", tree, ["--dir", "a", "--dir", "/b", "run"], "/w")
    assert result.group_flags == {"--dir": ["/w/a", "/b"]}
