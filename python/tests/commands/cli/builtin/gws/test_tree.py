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
from mirage.commands.cli.builtin.gws import GWS
from mirage.core.google.config import GoogleConfig
from mirage.io.types import materialize

CONFIG = {"client_id": "cid", "refresh_token": "rt"}


def leaf(*path: str):
    node = GWS
    for name in path:
        node = next(c for c in node.subcommands if c.name == name)
    return node


def test_tree_lists_every_service():
    assert GWS.name == "gws"
    assert GWS.config_model is GoogleConfig
    assert [g.name for g in GWS.subcommands
            ] == ["drive", "sheets", "docs", "slides", "gmail"]


def test_passthroughs_nest_by_discovery_resource():
    assert [v.name for v in leaf("drive", "files").subcommands] == [
        "list", "get", "create", "update", "copy", "delete", "export"
    ]
    assert [v.name for v in leaf("gmail", "users", "messages").subcommands
            ] == ["list", "get", "send", "trash", "attachments"]
    assert leaf("gmail", "users", "messages", "attachments",
                "get").fn is not None


def test_bespoke_verbs_drop_the_plus_marker():
    assert [v.name for v in leaf("gmail").subcommands][-6:] == [
        "send", "read", "reply", "reply-all", "forward", "triage"
    ]
    assert [v.name for v in leaf("sheets").subcommands
            ][-3:] == ["read", "write", "append"]
    assert leaf("docs", "write").write


def test_writes_follow_http_semantics():
    assert not leaf("drive", "files", "list").write
    assert leaf("drive", "files", "delete").write
    assert leaf("sheets", "spreadsheets", "batchUpdate").write
    assert not leaf("gmail", "triage").write


@pytest.mark.asyncio
async def test_missing_required_flag_exits_2():
    ws = Workspace({})
    ws.register_cli("gws", GWS, CONFIG)
    io = await ws.execute("gws gmail send --subject Hi --body yo")
    assert io.exit_code == 2
    err = await materialize(io.stderr)
    assert err.startswith(b"gws gmail send: option '--to' is required")
    await ws.close()


@pytest.mark.asyncio
async def test_unknown_verb_uses_git_wording():
    ws = Workspace({})
    ws.register_cli("gws", GWS, CONFIG)
    io = await ws.execute("gws drive bogus")
    assert io.exit_code == 1
    err = await materialize(io.stderr)
    assert err == (b"gws: 'bogus' is not a gws drive command. "
                   b"See 'gws drive --help'.\n")
    await ws.close()
