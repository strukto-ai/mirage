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

from mirage.commands.cli import CLISpec
from mirage.commands.spec.types import CommandSpec, Operand, Option
from mirage.runtime.types import ScriptSource


class _Config(BaseModel):
    token: str = ""


async def _verb(config, paths, *texts, **flags):
    return None


def _tree() -> CLISpec:
    return CLISpec(
        name="gws",
        description="Google Workspace",
        config_model=_Config,
        subcommands=(
            CLISpec(
                name="gmail",
                description="Gmail messages",
                subcommands=(
                    CLISpec(
                        name="send",
                        fn=_verb,
                        write=True,
                        options=(
                            Option(
                                short="-t",
                                long="--to",
                                type="str",
                                multiple=True,
                                required=True,
                            ),
                        ),
                        rest=Operand(type="str"),
                    ),
                    CLISpec(name="list", fn=_verb),
                ),
            ),
            CLISpec(
                name="docs",
                description="Google Docs",
                subcommands=(CLISpec(name="cat", fn=_verb),),
            ),
        ),
    )


def test_tree_builds_and_is_a_command_spec():
    gws = _tree()
    assert isinstance(gws, CommandSpec)
    assert [child.name for child in gws.subcommands] == ["gmail", "docs"]
    gmail = gws.subcommands[0]
    send = gmail.subcommands[0]
    assert send.write is True
    assert send.fn is _verb
    assert send.options[0].long == "--to"
    assert gws.config_model is _Config
    assert gmail.config_model is None


def test_single_verb_cli_is_a_leaf_root():
    curl_like = CLISpec(name="hello", fn=_verb)
    assert curl_like.subcommands == ()
    assert curl_like.write is False
    assert curl_like.limit is None


def test_group_may_carry_its_own_options():
    tree = CLISpec(
        name="git",
        options=(Option(short="-C", type="path"),),
        subcommands=(CLISpec(name="status", fn=_verb),),
    )
    assert tree.options[0].short == "-C"


@dataclass
class _StatefulVerb:
    calls: int = 0

    async def __call__(self, invocation):
        self.calls += 1


def test_name_must_be_a_single_word():
    with pytest.raises(ValueError, match="single non-empty word"):
        CLISpec(name="", fn=_verb)
    with pytest.raises(ValueError, match="single non-empty word"):
        CLISpec(name="gmail send", fn=_verb)
    with pytest.raises(ValueError, match="single non-empty word"):
        CLISpec(name="gmail\tsend", fn=_verb)
    with pytest.raises(ValueError, match="single non-empty word"):
        CLISpec(name="gmail\n", fn=_verb)


def test_node_takes_fn_or_subcommands_not_both():
    with pytest.raises(ValueError, match="not both"):
        CLISpec(
            name="gws", fn=_verb, subcommands=(CLISpec(name="send", fn=_verb),)
        )


def test_node_needs_fn_or_subcommands():
    with pytest.raises(ValueError, match="needs fn, subcommands, or script"):
        CLISpec(name="gws")


def test_script_root_stands_alone():
    spec = CLISpec(name="pager", script=ScriptSource("print('hi')"))
    assert spec.fn is None
    assert spec.subcommands == ()


def test_script_excludes_fn():
    with pytest.raises(ValueError, match="fn or script, not both"):
        CLISpec(name="pager", fn=_verb, script=ScriptSource("1"))


def test_script_excludes_subcommands():
    with pytest.raises(ValueError, match="subcommands belong to fn trees"):
        CLISpec(
            name="pager",
            script=ScriptSource("1"),
            subcommands=(CLISpec(name="send", fn=_verb),),
        )


def test_script_excludes_config_model():
    with pytest.raises(ValueError, match="config_model"):
        CLISpec(name="pager", script=ScriptSource("1"), config_model=_Config)


def test_runtime_takes_script():
    with pytest.raises(ValueError, match="it takes script"):
        CLISpec(name="pager", fn=_verb, runtime="monty")
    spec = CLISpec(name="pager", script=ScriptSource("1"), runtime="monty")
    assert spec.runtime == "monty"


def test_script_is_root_only():
    with pytest.raises(ValueError, match="only the root of a tree may"):
        CLISpec(
            name="gws",
            subcommands=(CLISpec(name="pager", script=ScriptSource("1")),),
        )


def test_group_declares_no_positional_or_rest():
    with pytest.raises(ValueError, match="belong on leaves"):
        CLISpec(
            name="gws",
            positional=(Operand(type="str"),),
            subcommands=(CLISpec(name="send", fn=_verb),),
        )
    with pytest.raises(ValueError, match="belong on leaves"):
        CLISpec(
            name="gws",
            rest=Operand(type="str"),
            subcommands=(CLISpec(name="send", fn=_verb),),
        )


def test_duplicate_subcommand_names_raise():
    with pytest.raises(ValueError, match="duplicate subcommand 'send'"):
        CLISpec(
            name="gws",
            subcommands=(
                CLISpec(name="send", fn=_verb),
                CLISpec(name="send", fn=_verb),
            ),
        )


def test_config_model_is_root_only():
    with pytest.raises(ValueError, match="only the root of a tree may"):
        CLISpec(
            name="gws",
            subcommands=(
                CLISpec(name="gmail", fn=_verb, config_model=_Config),
            ),
        )


def test_leaf_option_grammar_is_validated_at_construction():
    with pytest.raises(
        ValueError, match="choices and default require a value flag"
    ):
        CLISpec(
            name="mine",
            fn=_verb,
            options=(Option(long="--mode", choices=("a", "b")),),
        )


def test_unhashable_callable_handler_is_valid():
    handler = _StatefulVerb()
    spec = CLISpec(name="mine", fn=handler)
    assert spec.fn is handler


def test_spellingless_leaf_option_is_rejected_at_construction():
    with pytest.raises(ValueError, match="requires a short or long spelling"):
        CLISpec(name="mine", fn=_verb, options=(Option(),))


def test_duplicate_leaf_option_spelling_is_rejected_at_construction():
    with pytest.raises(ValueError, match="duplicate option spelling"):
        CLISpec(
            name="mine",
            fn=_verb,
            options=(Option(long="--mode"), Option(long="--mode", type="str")),
        )


def test_ancestor_descendant_option_collision_raises():
    with pytest.raises(ValueError, match="collides with subcommand"):
        CLISpec(
            name="gws",
            options=(Option(short="-C", long="--cwd", type="str"),),
            subcommands=(
                CLISpec(
                    name="gmail",
                    subcommands=(
                        CLISpec(
                            name="send",
                            fn=_verb,
                            options=(Option(long="--cwd", type="str"),),
                        ),
                    ),
                ),
            ),
        )


def test_sibling_leaves_may_share_option_spellings():
    tree = CLISpec(
        name="gws",
        subcommands=(
            CLISpec(
                name="send",
                fn=_verb,
                options=(Option(long="--to", type="str"),),
            ),
            CLISpec(
                name="share",
                fn=_verb,
                options=(Option(long="--to", type="str"),),
            ),
        ),
    )
    assert len(tree.subcommands) == 2


def test_alias_shares_the_sibling_namespace():
    with pytest.raises(ValueError, match="duplicate subcommand 'co'"):
        CLISpec(
            name="tool",
            subcommands=(
                CLISpec(name="checkout", aliases=("co",), fn=_verb),
                CLISpec(name="co", fn=_verb),
            ),
        )


def test_alias_must_be_a_single_word():
    with pytest.raises(ValueError, match="alias 'c o'"):
        CLISpec(
            name="tool",
            subcommands=(
                CLISpec(name="checkout", aliases=("c o",), fn=_verb),
            ),
        )
