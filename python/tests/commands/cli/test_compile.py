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
from pydantic import BaseModel

from mirage.commands.cli import CLISpec
from mirage.commands.spec.types import Operand, Option
from mirage.runtime.types import ScriptSource


class _Config(BaseModel):
    token: str = ""


async def _verb(config, paths, *texts, **flags):
    return None


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
        CLISpec(name="gws",
                fn=_verb,
                subcommands=(CLISpec(name="send", fn=_verb), ))


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
        CLISpec(name="pager",
                script=ScriptSource("1"),
                subcommands=(CLISpec(name="send", fn=_verb), ))


def test_runtime_takes_script():
    with pytest.raises(ValueError, match="it takes script"):
        CLISpec(name="pager", fn=_verb, runtime="monty")
    spec = CLISpec(name="pager", script=ScriptSource("1"), runtime="monty")
    assert spec.runtime == "monty"


def test_script_is_root_only():
    with pytest.raises(ValueError, match="only the root of a tree may"):
        CLISpec(name="gws",
                subcommands=(CLISpec(name="pager",
                                     script=ScriptSource("1")), ))


def test_group_declares_no_positional_or_rest():
    with pytest.raises(ValueError, match="belong on leaves"):
        CLISpec(name="gws",
                positional=(Operand(type="str"), ),
                subcommands=(CLISpec(name="send", fn=_verb), ))
    with pytest.raises(ValueError, match="belong on leaves"):
        CLISpec(name="gws",
                rest=Operand(type="str"),
                subcommands=(CLISpec(name="send", fn=_verb), ))


def test_duplicate_subcommand_names_raise():
    with pytest.raises(ValueError, match="duplicate subcommand 'send'"):
        CLISpec(name="gws",
                subcommands=(CLISpec(name="send",
                                     fn=_verb), CLISpec(name="send",
                                                        fn=_verb)))


def test_config_model_is_root_only():
    with pytest.raises(ValueError, match="only the root of a tree may"):
        CLISpec(name="gws",
                subcommands=(CLISpec(name="gmail",
                                     fn=_verb,
                                     config_model=_Config), ))


def test_ancestor_descendant_option_collision_raises():
    with pytest.raises(ValueError, match="collides with subcommand"):
        CLISpec(name="gws",
                options=(Option(short="-C", long="--cwd", type="str"), ),
                subcommands=(CLISpec(
                    name="gmail",
                    subcommands=(CLISpec(
                        name="send",
                        fn=_verb,
                        options=(Option(long="--cwd", type="str"), )), )), ))


def test_sibling_leaves_may_share_option_spellings():
    tree = CLISpec(
        name="gws",
        subcommands=(
            CLISpec(name="send",
                    fn=_verb,
                    options=(Option(long="--to", type="str"), )),
            CLISpec(name="share",
                    fn=_verb,
                    options=(Option(long="--to", type="str"), )),
        ),
    )
    assert len(tree.subcommands) == 2


def test_alias_shares_the_sibling_namespace():
    with pytest.raises(ValueError, match="duplicate subcommand 'co'"):
        CLISpec(name="tool",
                subcommands=(CLISpec(name="checkout",
                                     aliases=("co", ),
                                     fn=_verb), CLISpec(name="co", fn=_verb)))


def test_alias_must_be_a_single_word():
    with pytest.raises(ValueError, match="alias 'c o'"):
        CLISpec(name="tool",
                subcommands=(CLISpec(name="checkout",
                                     aliases=("c o", ),
                                     fn=_verb), ))
