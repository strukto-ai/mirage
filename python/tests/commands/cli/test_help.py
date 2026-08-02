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

from mirage.commands.cli import CLISpec, render_group_help
from mirage.commands.spec.types import OperandKind, Option


async def _verb(config, paths, *texts, **flags):
    return None


def test_group_help_full_shape():
    node = CLISpec(
        name="gws",
        description="Google Workspace",
        options=(Option(short="-C",
                        long="--cwd",
                        value_kind=OperandKind.TEXT,
                        description="run as if started there"), ),
        subcommands=(
            CLISpec(name="gmail",
                    description="Gmail messages\nlong tail ignored",
                    subcommands=(CLISpec(name="send", fn=_verb), )),
            CLISpec(name="docs", subcommands=(CLISpec(name="cat",
                                                      fn=_verb), )),
        ),
    )
    assert render_group_help(
        "gws", node) == ("usage: gws [<options>] <command> [<args>]\n"
                         "\n"
                         "Google Workspace\n"
                         "\n"
                         "Commands:\n"
                         "  docs\n"
                         "  gmail  Gmail messages\n"
                         "\n"
                         "Flags:\n"
                         "  -C, --cwd <text>  run as if started there\n")


def test_group_help_minimal_shape():
    node = CLISpec(name="tool", subcommands=(CLISpec(name="run", fn=_verb), ))
    assert render_group_help("tool",
                             node) == ("usage: tool <command> [<args>]\n"
                                       "\n"
                                       "Commands:\n"
                                       "  run\n")
