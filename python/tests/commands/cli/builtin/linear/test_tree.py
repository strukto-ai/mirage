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

from mirage import Workspace
from mirage.commands.cli.builtin.linear import LINEAR
from mirage.core.linear.config import LinearConfig

CONFIG = {"api_key": "lin_api_test"}

NOUNS = [
    "team",
    "issue",
    "project",
    "cycle",
    "label",
    "comment",
    "user",
    "document",
    "search",
]


def leaf(*path: str):
    node = LINEAR
    for name in path:
        node = next(c for c in node.subcommands if c.name == name)
    return node


def test_tree_shape_keeps_the_mount_grammar():
    assert LINEAR.name == "linear"
    assert LINEAR.config_model is LinearConfig
    assert [g.name for g in LINEAR.subcommands] == NOUNS
    assert [v.name for v in leaf("issue").subcommands] == [
        "list",
        "get",
        "create",
        "update",
        "assign",
        "transition",
        "set-priority",
        "set-project",
        "add-label",
    ]
    assert [v.name
            for v in leaf("comment").subcommands] == ["list", "add", "update"]


def test_write_classification():
    for noun, verb in (
        ("issue", "create"),
        ("issue", "update"),
        ("issue", "assign"),
        ("issue", "transition"),
        ("issue", "set-priority"),
        ("issue", "set-project"),
        ("issue", "add-label"),
        ("comment", "add"),
        ("comment", "update"),
    ):
        assert leaf(noun, verb).write
    for noun, verb in (
        ("team", "list"),
        ("issue", "list"),
        ("issue", "get"),
        ("comment", "list"),
    ):
        assert not leaf(noun, verb).write


def test_issue_operand_is_positional():
    assert leaf("issue", "get").rest is not None
    assert leaf("issue", "update").rest is not None
    assert leaf("issue", "list").rest is None


@pytest.mark.asyncio
async def test_missing_required_team_flag_exits_2():
    ws = Workspace({})
    ws.register_cli("linear", LINEAR, CONFIG)
    io = await ws.execute("linear issue list")
    assert io.exit_code == 2
    await ws.close()
