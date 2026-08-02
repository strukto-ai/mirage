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

from pydantic import BaseModel

from mirage.commands.cli import CLISpec
from mirage.commands.spec.types import (CommandSpec, Operand, OperandKind,
                                        Option)


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
            CLISpec(name="gmail",
                    description="Gmail messages",
                    subcommands=(
                        CLISpec(name="send",
                                fn=_verb,
                                write=True,
                                options=(Option(short="-t",
                                                long="--to",
                                                value_kind=OperandKind.TEXT,
                                                multiple=True,
                                                required=True), ),
                                rest=Operand(kind=OperandKind.TEXT)),
                        CLISpec(name="list", fn=_verb),
                    )),
            CLISpec(name="docs",
                    description="Google Docs",
                    subcommands=(CLISpec(name="cat", fn=_verb), )),
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
    assert curl_like.safeguard is None


def test_group_may_carry_its_own_options():
    tree = CLISpec(
        name="git",
        options=(Option(short="-C", value_kind=OperandKind.PATH), ),
        subcommands=(CLISpec(name="status", fn=_verb), ),
    )
    assert tree.options[0].short == "-C"
