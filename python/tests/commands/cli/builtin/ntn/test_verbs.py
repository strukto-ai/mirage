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

from mirage.commands.cli.builtin.ntn.blocks.append import append
from mirage.commands.cli.builtin.ntn.comments.create import \
    create as comment_create
from mirage.commands.cli.builtin.ntn.datasources.query import query
from mirage.commands.cli.builtin.ntn.pages.edit import edit
from mirage.commands.cli.builtin.ntn.pages.get import get
from mirage.commands.cli.builtin.ntn.pages.trash import trash
from mirage.commands.cli.builtin.ntn.search import search
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.errors import UsageError
from mirage.core.notion.config import NotionConfig
from mirage.io.types import materialize

CONFIG = NotionConfig(api_key="secret")


async def _json(out):
    return json.loads(await materialize(out))


@pytest.mark.asyncio
async def test_pages_get(monkeypatch):

    async def fake_get(config, page_id):
        return {"id": page_id}

    monkeypatch.setitem(get.__globals__, "get_page", fake_get)
    out, _io = await get(CLIInvocation(CONFIG, flags={"page": "P1"}))
    assert (await _json(out))["id"] == "P1"


@pytest.mark.asyncio
async def test_pages_edit_and_trash(monkeypatch):
    calls = []

    async def fake_update(config, page_id, body):
        calls.append((page_id, body))
        return {"id": page_id, **body}

    monkeypatch.setitem(edit.__globals__, "update_page", fake_update)
    monkeypatch.setitem(trash.__globals__, "update_page", fake_update)
    await edit(
        CLIInvocation(CONFIG,
                      flags={
                          "page": "P1",
                          "json": '{"archived":true}'
                      }))
    await trash(CLIInvocation(CONFIG, flags={"page": "P2"}))
    assert calls == [
        ("P1", {
            "archived": True
        }),
        ("P2", {
            "in_trash": True
        }),
    ]


@pytest.mark.asyncio
async def test_blocks_append_requires_children(monkeypatch):

    async def fake_append(config, block_id, body):
        return {"results": []}

    monkeypatch.setitem(append.__globals__, "append_blocks", fake_append)
    with pytest.raises(UsageError, match="must contain children"):
        await append(
            CLIInvocation(CONFIG, flags={
                "block": "B1",
                "json": '{"foo":1}'
            }))
    out, _io = await append(
        CLIInvocation(CONFIG, flags={
            "block": "B1",
            "json": '{"children":[]}'
        }))
    assert await _json(out) == {"results": []}


@pytest.mark.asyncio
async def test_comments_create_requires_parent(monkeypatch):

    async def fake_comment(config, body):
        return {"id": "C1"}

    monkeypatch.setitem(comment_create.__globals__, "create_comment",
                        fake_comment)
    with pytest.raises(UsageError, match="must contain parent"):
        await comment_create(
            CLIInvocation(CONFIG, flags={"json": '{"rich_text":[]}'}))
    out, _io = await comment_create(
        CLIInvocation(
            CONFIG,
            flags={"json": '{"parent":{"page_id":"P1"},"rich_text":[]}'}))
    assert (await _json(out))["id"] == "C1"


@pytest.mark.asyncio
async def test_datasources_query_forwards_filter(monkeypatch):
    calls = []

    async def fake_query(config, database_id, body=None):
        calls.append((database_id, body))
        return [{"id": "row1"}]

    monkeypatch.setitem(query.__globals__, "query_database", fake_query)
    out, _io = await query(
        CLIInvocation(CONFIG,
                      flags={
                          "datasource": "D1",
                          "json": '{"filter":{"x":1}}'
                      }))
    assert calls == [("D1", {"filter": {"x": 1}})]
    assert await _json(out) == [{"id": "row1"}]


@pytest.mark.asyncio
async def test_search_normalizes_rows(monkeypatch):

    async def fake_search(config, query="", page_size=20, max_results=None):
        return [{
            "id": "P1",
            "url": "u",
            "last_edited_time": "t",
            "parent": {
                "type": "workspace"
            },
            "properties": {
                "title": {
                    "type": "title",
                    "title": [{
                        "plain_text": "Doc"
                    }],
                }
            },
        }]

    monkeypatch.setitem(search.__globals__, "search_pages", fake_search)
    out, _io = await search(CLIInvocation(CONFIG, flags={"query": "doc"}))
    rows = await _json(out)
    assert rows[0]["page_id"] == "P1"
    assert rows[0]["parent_type"] == "workspace"
