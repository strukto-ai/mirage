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

from mirage.commands.cli.builtin.trello import TRELLO
from mirage.commands.cli.specs import cli_spec_for
from mirage.commands.spec.compile import compile_spec
from mirage.commands.spec.types import CommandSpec
from mirage.core.trello.config import TrelloConfig

WRITES = [
    "create",
    "update",
    "move",
    "assign",
    "label",
    "unlabel",
    "comment",
    "comment-update",
]


def leaf(*path: str) -> CommandSpec:
    node = TRELLO.spec
    for name in path:
        node = next(c for c in node.subcommands if c.name == name)
    return node


def test_tree_keeps_the_verbs_the_mount_spoke():
    assert TRELLO.spec.name == "trello"
    assert TRELLO.config_model is TrelloConfig
    assert cli_spec_for("trello") is TRELLO
    assert [g.name for g in TRELLO.spec.subcommands] == [
        "board",
        "list",
        "label",
        "card",
    ]
    assert [v.name for v in leaf("board").subcommands] == [
        "list",
        "show",
        "members",
    ]
    assert [v.name for v in leaf("card").subcommands] == [
        "list",
        "show",
        "comments",
        *WRITES,
    ]


def test_write_classification():
    for verb in WRITES:
        assert TRELLO.handlers[f"card {verb}"].write
    for path in ("board list", "board show", "card show", "card comments"):
        assert not TRELLO.handlers[path].write


def test_ids_are_positional_on_reads_and_flags_on_writes():
    assert compile_spec(leaf("card", "show")).rest is not None
    assert compile_spec(leaf("board", "list")).rest is None
    assert compile_spec(leaf("card", "create")).rest is None
    assert sorted(
        option.names[-1]
        for option in compile_spec(leaf("card", "update")).options
    ) == ["--card_id", "--closed", "--desc", "--desc_file", "--due", "--name"]
