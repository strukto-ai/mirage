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

import re

import pytest

from mirage import Workspace
from mirage.commands.cli.specs import cli_spec_for
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.policy.errors import PolicyError
from mirage.policy.profile import command_tree, tree_doc
from mirage.policy.types import Grammar
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace.session.validate import (
    BUILTIN_GRAMMARS,
    normalize_tree,
    renormalized,
)
from tests.fixtures.command_trees import trees


def _noop(config, paths, texts, ctx):
    return 0


def _prog() -> CLI:
    return CLI(
        spec=CommandSpec(
            name="prog",
            subcommands=(
                CommandSpec(
                    name="run",
                    aliases=("go",),
                    arguments=(
                        Argument("-v", "--verbose", action="store_true"),
                    ),
                ),
            ),
        ),
        handlers={"run": CLIHandler(fn=_noop)},
    )


def test_create_session_reads_the_verbs_of_an_installed_cli():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    ws.register_cli("prog", _prog())
    with pytest.raises(PolicyError, match="no subcommand walk"):
        ws.create_session(
            "bad", permissions={"commands": {"prog": {"walk": "deny"}}}
        )
    good = ws.create_session(
        "good", permissions={"commands": {"prog": {"go": {"-v": "deny"}}}}
    )
    assert good.commands is not None
    assert tree_doc(good.commands.trees[0].tree) == {
        "prog": {"run": {"--verbose": "deny"}}
    }


def test_create_session_reads_the_verbs_of_a_tree_a_mount_serves():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    ws.mount("/data").register_commands(
        [
            CLI(
                spec=CommandSpec(
                    name="tool",
                    subcommands=(
                        CommandSpec(
                            name="peek",
                            arguments=(
                                Argument("--all", action="store_true"),
                            ),
                        ),
                    ),
                ),
                handlers={"peek": CLIHandler(fn=_noop)},
            )
        ]
    )

    def deny(block: dict) -> dict:
        return {"commands": {"tool": block}}

    with pytest.raises(PolicyError, match="no subcommand poke"):
        ws.create_session("bad", permissions=deny({"poke": "deny"}))
    ws.create_session("good", permissions=deny({"peek": {"--all": "deny"}}))


def test_create_session_refuses_options_on_a_command_with_no_grammar():
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    with pytest.raises(PolicyError, match="no grammar here"):
        ws.create_session(
            "bad", permissions={"commands": {"prog": {"--verbose": "deny"}}}
        )
    ws.create_session(
        "good", permissions={"commands": {"prog": {"operands": {"x": "deny"}}}}
    )


def test_every_profile_is_checked_when_the_workspace_is_created():
    with pytest.raises(PolicyError, match="no option --amdin"):
        Workspace(
            {"/data/": RAMVFS()},
            profiles={"unused": {"commands": {"rm": {"--amdin": "deny"}}}},
        )
    with pytest.raises(PolicyError, match="no subcommand walk"):
        Workspace(
            {"/data/": RAMVFS()},
            clis={"prog": (_prog(), None)},
            profiles={"unused": {"commands": {"prog": {"walk": "deny"}}}},
        )


def test_a_profile_naming_a_cli_registered_later_waits_for_it():
    doc = {"commands": {"prog": {"go": "deny"}}}
    ws = Workspace({"/data/": RAMVFS()}, profiles={"default": doc})
    with pytest.raises(PolicyError, match="go is no subcommand here"):
        ws.create_session("early", profile="default")
    ws.register_cli("prog", _prog())
    default = ws.get_session(ws.default_session_id).commands
    assert default is not None
    assert tree_doc(default.trees[0].tree) == {"prog": {"run": "deny"}}
    ws.create_session("late", profile="default")


@pytest.mark.asyncio
async def test_a_mount_serving_a_cli_later_renames_the_rules_naming_it():
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles={"default": {"commands": {"prog": {"go": "deny"}}}},
    )
    try:
        ws.mount("/data").register_commands([_prog()])
        for verb in ("go", "run"):
            ran = await ws.shell(f"cd /data && prog {verb}")
            assert ran.exit_code == 126
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_mount_refuses_a_cli_a_profile_names_wrongly():
    ws = Workspace(
        {"/data/": RAMVFS()},
        mode=MountMode.WRITE,
        profiles={"p": {"commands": {"prog": {"walk": "deny"}}}},
    )
    try:
        with pytest.raises(PolicyError, match="no subcommand walk"):
            ws.mount("/data").register_commands([_prog()])
        ran = await ws.shell("cd /data && prog run")
        assert ran.exit_code == 127
    finally:
        await ws.close()


def test_register_cli_refuses_a_cli_a_profile_names_wrongly():
    ws = Workspace(
        {"/data/": RAMVFS()},
        profiles={"p": {"commands": {"prog": {"walk": "deny"}}}},
    )
    with pytest.raises(PolicyError, match="no subcommand walk"):
        ws.register_cli("prog", _prog())
    assert "prog" not in ws.clis()


def test_renormalized_holds_a_deferred_tree_by_the_grammar_it_has_now():
    held = trees({"prog": {"go": {"-v": "deny"}}}, inline={"rm": "deny"})
    grammars = {**BUILTIN_GRAMMARS, "prog": Grammar(_prog().spec, tree=True)}
    again = renormalized(held, grammars)
    assert again is not None
    assert tree_doc(again.trees[0].tree) == {
        "prog": {"run": {"--verbose": "deny"}}
    }
    assert again.trees[1].inline
    assert renormalized(None, grammars) is None


def _grammars() -> dict[str, Grammar]:
    grammars = dict(BUILTIN_GRAMMARS)
    for name in ("gh", "git"):
        cli = cli_spec_for(name)
        grammars[name] = Grammar(cli.spec, tree=True)
    return grammars


def _normalized(doc, **kwargs):
    return tree_doc(normalize_tree(command_tree(doc), _grammars(), **kwargs))


def test_a_tree_holds_each_name_by_its_canonical_spelling():
    written = {
        "rm": {"-r": "ask", "-f": "deny", "-i": "allow"},
        "gh": {"pr": {"ls": "deny", "merge": {"-R": "ask"}}},
        "git": {"-C": "deny", "checkout": {"operands": {"main": "deny"}}},
        "head": {"-n": {"values": {"-5": "deny"}}},
    }
    assert _normalized(written) == {
        "rm": {"--recursive": "ask", "--force": "deny", "-i": "allow"},
        "gh": {"pr": {"list": "deny", "merge": {"--repo": "ask"}}},
        "git": {"-C": "deny", "checkout": {"operands": {"main": "deny"}}},
        "head": {"--lines": {"values": {"-5": "deny"}}},
    }


@pytest.mark.parametrize(
    "doc, says",
    [
        ({"gh": {"pr": {"mrge": "deny"}}}, "no subcommand mrge"),
        ({"gh": {"pr": {"merge": {"--amdin": "deny"}}}}, "no option --amdin"),
        (
            {"gh": {"pr": {"merge": {"admin": "deny"}}}},
            "admin is no subcommand here; an operand goes under operands",
        ),
        ({"gh": {"operands": {"x": "deny"}}}, "takes a subcommand"),
        ({"kubectl": {"--namespace": "deny"}}, "no grammar here"),
        ({"kubectl": {"get": "deny"}}, "get is no subcommand here"),
        ({"rm": {"-r": "ask", "--recursive": "deny"}}, "same option"),
        ({"gh": {"pr": {"ls": "deny", "list": "allow"}}}, "same subcommand"),
        ({"rm": {"-rf": "deny"}}, "cluster of options; write -r and -f"),
        ({"git": {"-f": "deny"}}, "-f names different options below"),
        ({"rm": {"--force": {"values": {"x": "deny"}}}}, "takes no value"),
        (
            {"git": {"status": {"-u": {"values": {"some": "deny"}}}}},
            "takes none of 'some'",
        ),
    ],
)
def test_a_name_its_grammar_lacks_or_reads_two_ways_is_refused(doc, says):
    with pytest.raises(PolicyError, match=re.escape(says)):
        normalize_tree(command_tree(doc), _grammars())


def test_a_command_with_no_grammar_keeps_its_operands_and_can_wait():
    assert _normalized({"kubectl": {"operands": {"get": "deny"}}}) == {
        "kubectl": {"operands": {"get": "deny"}}
    }
    assert _normalized({"kubectl": {"--namespace": "deny"}}, defer=True) == {
        "kubectl": {"--namespace": "deny"}
    }


def test_a_shell_builtin_waits_for_no_grammar():
    with pytest.raises(
        PolicyError,
        match=re.escape(
            "commands.printenv: GATED is no subcommand here; an operand "
            "goes under operands"
        ),
    ):
        _normalized({"printenv": {"GATED": "deny"}}, defer=True)
    assert _normalized(
        {"printenv": {"operands": {"GATED": "deny"}}}, defer=True
    ) == {"printenv": {"operands": {"GATED": "deny"}}}
