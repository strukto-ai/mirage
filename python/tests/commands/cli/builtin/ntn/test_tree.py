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

import json

import pytest

from mirage import Workspace
from mirage.commands.cli.builtin.ntn import NTN
from mirage.commands.cli.builtin.ntn.pages import create as pages_create
from mirage.core.notion.config import NotionConfig
from mirage.io.types import materialize

CONFIG = {"api_key": "secret"}


def leaf(*path: str):
    node = NTN
    for name in path:
        node = next(c for c in node.subcommands if c.name == name)
    return node


def test_tree_shape_matches_the_official_grammar():
    assert NTN.name == "ntn"
    assert NTN.config_model is NotionConfig
    assert [g.name for g in NTN.subcommands
            ] == ["pages", "blocks", "comments", "datasources", "search"]
    assert [v.name for v in leaf("pages").subcommands
            ] == ["get", "create", "edit", "trash"]
    assert [v.name for v in leaf("datasources").subcommands] == ["query"]


def test_write_classification():
    assert not leaf("pages", "get").write
    for verb in ("create", "edit", "trash"):
        assert leaf("pages", verb).write
    assert leaf("blocks", "append").write
    assert leaf("comments", "create").write
    assert not leaf("datasources", "query").write
    assert not leaf("search").write


@pytest.mark.asyncio
async def test_installed_tree_dispatches_pages_create(monkeypatch):

    async def fake_create(config, body):
        return {"id": "P1", "object": "page", "parent": body["parent"]}

    monkeypatch.setitem(pages_create.create.__globals__, "create_page",
                        fake_create)
    ws = Workspace({})
    ws.register_cli("ntn", NTN, CONFIG)
    io = await ws.execute(
        'ntn pages create --json \'{"parent":{"page_id":"root"}}\'')
    assert io.exit_code == 0
    out = json.loads(await materialize(io.stdout))
    assert out["id"] == "P1"
    await ws.close()


@pytest.mark.asyncio
async def test_malformed_json_is_a_usage_error():
    ws = Workspace({})
    ws.register_cli("ntn", NTN, CONFIG)
    io = await ws.execute("ntn pages create --json '{not json'")
    assert io.exit_code == 2
    assert (await materialize(io.stderr)) == b"--json must be valid JSON\n"
    await ws.close()
