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

from dataclasses import dataclass

import pytest
from pydantic import BaseModel

from mirage.commands.cli import CLI, CLIHandler
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.runtime.types import ScriptSource


class _Config(BaseModel):
    token: str = ""


async def _verb(inv):
    return None


@dataclass
class _StatefulVerb:
    calls: int = 0

    async def __call__(self, invocation):
        self.calls += 1


@pytest.mark.parametrize("name", ["", "gmail send", "gmail\tsend", "gmail\n"])
def test_name_must_be_a_single_word(name):
    with pytest.raises(ValueError, match="single non-empty word"):
        CLI(CommandSpec(name=name), handlers={"": CLIHandler(_verb)})


def test_every_leaf_requires_a_handler():
    with pytest.raises(ValueError, match="missing handlers"):
        CLI(CommandSpec(name="gws", subcommands=(CommandSpec(name="send"),)))


def test_a_handler_cannot_target_a_group_or_unknown_path():
    with pytest.raises(ValueError, match="do not name leaves"):
        CLI(
            CommandSpec(name="gws", subcommands=(CommandSpec(name="send"),)),
            handlers={"": CLIHandler(_verb), "send": CLIHandler(_verb)},
        )


def test_handlers_require_a_callable_for_non_script_clis():
    with pytest.raises(ValueError, match="needs a handler fn"):
        CLI(CommandSpec(name="gws"), handlers={"": CLIHandler()})


def test_script_root_owns_its_argv_without_a_grammar():
    cli = CLI(CommandSpec(name="pager"), script=ScriptSource("print('hi')"))
    assert cli.handlers[""].fn is None
    assert cli.spec.subcommands == ()
    assert cli.spec.add_help is False


def test_script_excludes_fn():
    with pytest.raises(ValueError, match="fn or script, not both"):
        CLI(
            CommandSpec(name="pager"),
            handlers={"": CLIHandler(_verb)},
            script=ScriptSource("1"),
        )


def test_script_excludes_subcommands():
    with pytest.raises(ValueError, match="script serves the whole program"):
        CLI(
            CommandSpec(name="pager", subcommands=(CommandSpec(name="send"),)),
            script=ScriptSource("1"),
        )


def test_script_excludes_config_model():
    with pytest.raises(ValueError, match="config_model"):
        CLI(
            CommandSpec(name="pager"),
            script=ScriptSource("1"),
            config_model=_Config,
        )


def test_runtime_requires_a_script():
    with pytest.raises(ValueError, match="it takes script"):
        CLI(
            CommandSpec(name="pager"),
            handlers={"": CLIHandler(_verb)},
            runtime="monty",
        )
    cli = CLI(
        CommandSpec(name="pager"), script=ScriptSource("1"), runtime="monty"
    )
    assert cli.runtime == "monty"


@pytest.mark.parametrize(
    "argument", [Argument("text", nargs="?"), Argument("texts", nargs="*")]
)
def test_group_positional_arguments_are_rejected(argument):
    with pytest.raises(ValueError, match="belong on leaves"):
        CLI(
            CommandSpec(
                name="gws",
                subcommands=(CommandSpec(name="send"),),
                arguments=(argument,),
            ),
            handlers={"send": CLIHandler(_verb)},
        )


def test_duplicate_subcommand_names_raise():
    with pytest.raises(ValueError, match="duplicate subcommand 'send'"):
        CLI(
            CommandSpec(
                name="gws",
                subcommands=(
                    CommandSpec(name="send"),
                    CommandSpec(name="send"),
                ),
            ),
            handlers={"send": CLIHandler(_verb)},
        )


def test_leaf_argument_grammar_is_validated_at_registration():
    with pytest.raises(
        ValueError, match="choices and default require a value flag"
    ):
        CLI(
            CommandSpec(
                name="mine",
                arguments=(
                    Argument(
                        "--mode", action="store_true", choices=("a", "b")
                    ),
                ),
            ),
            handlers={"": CLIHandler(_verb)},
        )


def test_unhashable_callable_handler_is_valid():
    handler = _StatefulVerb()
    cli = CLI(CommandSpec(name="mine"), handlers={"": CLIHandler(handler)})
    assert cli.handlers[""].fn is handler


def test_ancestor_descendant_option_collision_raises():
    with pytest.raises(ValueError, match="collides with subcommand"):
        CLI(
            CommandSpec(
                name="gws",
                arguments=(Argument("-C", "--cwd"),),
                subcommands=(
                    CommandSpec(
                        name="gmail",
                        subcommands=(
                            CommandSpec(
                                name="send", arguments=(Argument("--cwd"),)
                            ),
                        ),
                    ),
                ),
            ),
            handlers={"gmail send": CLIHandler(_verb)},
        )


def test_sibling_leaves_may_share_option_spellings():
    cli = CLI(
        CommandSpec(
            name="gws",
            subcommands=(
                CommandSpec(name="send", arguments=(Argument("--to"),)),
                CommandSpec(name="share", arguments=(Argument("--to"),)),
            ),
        ),
        handlers={"send": CLIHandler(_verb), "share": CLIHandler(_verb)},
    )
    assert len(cli.spec.subcommands) == 2


def test_alias_shares_the_sibling_namespace():
    with pytest.raises(ValueError, match="duplicate subcommand 'co'"):
        CLI(
            CommandSpec(
                name="tool",
                subcommands=(
                    CommandSpec(name="checkout", aliases=("co",)),
                    CommandSpec(name="co"),
                ),
            ),
            handlers={"checkout": CLIHandler(_verb), "co": CLIHandler(_verb)},
        )


def test_alias_must_be_a_single_word():
    with pytest.raises(ValueError, match="alias 'c o'"):
        CLI(
            CommandSpec(
                name="tool",
                subcommands=(CommandSpec(name="checkout", aliases=("c o",)),),
            ),
            handlers={"checkout": CLIHandler(_verb)},
        )


def test_registration_copies_its_handler_mapping():
    handlers = {"": CLIHandler(_verb)}
    cli = CLI(CommandSpec(name="tool"), handlers=handlers)
    handlers.clear()
    assert cli.handlers[""].fn is _verb
    with pytest.raises(TypeError):
        cli.handlers[""] = CLIHandler()
