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
from mirage.commands.spec.types import Operand, OperandKind


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
    with pytest.raises(ValueError, match="needs fn or subcommands"):
        CLISpec(name="gws")


def test_group_declares_no_positional_or_rest():
    with pytest.raises(ValueError, match="belong on leaves"):
        CLISpec(name="gws",
                positional=(Operand(kind=OperandKind.TEXT), ),
                subcommands=(CLISpec(name="send", fn=_verb), ))
    with pytest.raises(ValueError, match="belong on leaves"):
        CLISpec(name="gws",
                rest=Operand(kind=OperandKind.TEXT),
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
