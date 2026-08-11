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

from mirage.commands.cli.builtin.ntn.api import api
from mirage.commands.cli.builtin.ntn.auth.token import token
from mirage.commands.cli.builtin.ntn.datasources.query import query
from mirage.commands.cli.builtin.ntn.datasources.resolve import resolve
from mirage.commands.cli.builtin.ntn.pages.create import create
from mirage.commands.cli.builtin.ntn.pages.edit import edit
from mirage.commands.cli.builtin.ntn.pages.get import get
from mirage.commands.cli.builtin.ntn.pages.trash import trash
from mirage.commands.cli.builtin.ntn.whoami import whoami, whoami_row
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.errors import UsageError
from mirage.core.notion.config import NotionConfig
from mirage.io.types import materialize

CONFIG = NotionConfig(api_key="secret")

USER_OWNED = {
    "id": "ID",
    "name": "NAME",
    "type": "bot",
    "bot": {
        "owner": {
            "type": "user",
            "user": {
                "id": "OWNERID",
                "name": "OWNERNAME",
                "type": "person",
                "person": {
                    "email": "e@x.com"
                },
            },
        },
        "workspace_id": "WSID",
        "workspace_name": "WSNAME",
    },
}

WORKSPACE_OWNED = {
    "id": "ID",
    "name": "NAME",
    "type": "bot",
    "bot": {
        "owner": {
            "type": "workspace",
            "workspace": True
        },
        "workspace_id": "WSID",
        "workspace_name": "WSNAME",
    },
}


async def _json(out):
    return json.loads(await materialize(out))


async def _text(out):
    return (await materialize(out)).decode()


@pytest.mark.asyncio
async def test_pages_get_renders_markdown_with_frontmatter(monkeypatch):

    async def fake_markdown(config, page_id):
        return {"object": "page_markdown", "markdown": "# Body\n"}

    async def fake_page(config, page_id):
        return {
            "id": page_id,
            "properties": {
                "title": {
                    "type": "title",
                    "title": [{
                        "plain_text": "Doc"
                    }],
                }
            },
        }

    monkeypatch.setitem(get.__globals__, "get_page_markdown", fake_markdown)
    monkeypatch.setitem(get.__globals__, "get_page", fake_page)
    out, _io = await get(CLIInvocation(CONFIG, texts=("P1", )))
    assert await _text(out) == "---\ntitle: Doc\n---\n\n# Body\n"

    out, _io = await get(
        CLIInvocation(CONFIG, texts=("P1", ), flags={"json": True}))
    payload = await _json(out)
    assert payload["markdown"]["object"] == "page_markdown"
    assert payload["page"]["id"] == "P1"


@pytest.mark.asyncio
async def test_pages_get_needs_a_positional_id():
    with pytest.raises(UsageError, match="page id is required"):
        await get(CLIInvocation(CONFIG))


@pytest.mark.asyncio
async def test_pages_create_posts_markdown_and_prints_the_id(monkeypatch):
    calls = []

    async def fake_create(config, body):
        calls.append(body)
        return {"id": "NEW"}

    monkeypatch.setitem(create.__globals__, "create_page", fake_create)
    out, _io = await create(
        CLIInvocation(CONFIG, flags={
            "content": "# Hi",
            "parent": "page:root"
        }))
    assert calls == [{"markdown": "# Hi", "parent": {"page_id": "root"}}]
    assert await _text(out) == "NEW\n"


@pytest.mark.asyncio
async def test_pages_create_maps_every_parent_kind(monkeypatch):
    calls = []

    async def fake_create(config, body):
        calls.append(body["parent"])
        return {"id": "NEW"}

    monkeypatch.setitem(create.__globals__, "create_page", fake_create)
    for spec, expected in (
        ("database:D1", {
            "database_id": "D1"
        }),
        ("data-source:S1", {
            "data_source_id": "S1"
        }),
    ):
        await create(
            CLIInvocation(CONFIG, flags={
                "content": "#",
                "parent": spec
            }))
    assert calls == [{"database_id": "D1"}, {"data_source_id": "S1"}]


@pytest.mark.asyncio
async def test_pages_create_refuses_a_malformed_parent():
    with pytest.raises(UsageError, match="--parent must be"):
        await create(
            CLIInvocation(CONFIG, flags={
                "content": "#",
                "parent": "nope:X"
            }))


@pytest.mark.asyncio
async def test_pages_edit_replaces_the_body(monkeypatch):
    calls = []

    async def fake_replace(config, page_id, markdown):
        calls.append((page_id, markdown))
        return {"object": "page_markdown"}

    monkeypatch.setitem(edit.__globals__, "replace_page_markdown",
                        fake_replace)
    out, _io = await edit(
        CLIInvocation(CONFIG, texts=("P1", ), flags={"content": "# New"}))
    assert calls == [("P1", "# New")]
    assert await _text(out) == "P1\n"


@pytest.mark.asyncio
async def test_pages_trash_refuses_without_yes(monkeypatch):
    calls = []

    async def fake_update(config, page_id, body):
        calls.append((page_id, body))
        return {"id": page_id}

    monkeypatch.setitem(trash.__globals__, "update_page", fake_update)
    out, io = await trash(CLIInvocation(CONFIG, texts=("P2", )))
    assert out is None
    assert io.exit_code == 1
    assert "non-interactive" in (await materialize(io.stderr)).decode()
    assert calls == []

    _out, io = await trash(
        CLIInvocation(CONFIG, texts=("P2", ), flags={"yes": True}))
    assert calls == [("P2", {"in_trash": True})]
    assert (await materialize(io.stderr)).decode() == "✔ Page trashed\n"


@pytest.mark.asyncio
async def test_datasources_resolve_lists_stubs(monkeypatch):

    async def fake_database(config, database_id):
        return {"data_sources": [{"id": "S1", "name": "Tasks"}]}

    monkeypatch.setitem(resolve.__globals__, "get_database", fake_database)
    out, _io = await resolve(CLIInvocation(CONFIG, texts=("D1", )))
    assert await _text(out) == "S1\tTasks\n"

    out, _io = await resolve(
        CLIInvocation(CONFIG, texts=("D1", ), flags={"json": True}))
    assert (await _json(out))["data_sources"][0]["name"] == "Tasks"


@pytest.mark.asyncio
async def test_datasources_query_sorts_columns_by_name(monkeypatch):
    calls = []

    async def fake_source(config, source_id):
        return {
            "id": source_id,
            "properties": {
                "Priority": {
                    "type": "number"
                },
                "Name": {
                    "type": "title"
                },
            },
        }

    async def fake_query(config, source_id, body):
        calls.append((source_id, body))
        return {
            "results": [{
                "id": "R1",
                "properties": {
                    "Name": {
                        "type": "title",
                        "title": [{
                            "plain_text": "Write spec"
                        }],
                    },
                    "Priority": {
                        "type": "number",
                        "number": 2
                    },
                },
            }],
            "has_more":
            False,
        }

    monkeypatch.setitem(query.__globals__, "get_data_source", fake_source)
    monkeypatch.setitem(query.__globals__, "query_data_source_page",
                        fake_query)
    out, _io = await query(
        CLIInvocation(CONFIG,
                      texts=("S1", ),
                      flags={
                          "limit": 5,
                          "sort": ["Priority desc"]
                      }))
    assert calls == [("S1", {
        "page_size":
        5,
        "sorts": [{
            "property": "Priority",
            "direction": "descending"
        }],
    })]
    assert await _text(out) == "R1\tWrite spec\t2\n"


@pytest.mark.asyncio
async def test_datasources_query_takes_columns_from_the_rows(monkeypatch):
    # Upstream derives the columns from the page objects it got back, not
    # from the data source's schema, so a result set that does not cover
    # the schema prints narrower. A row created from Markdown alone holds
    # only its title column, and on its own it prints as `<id>\t<title>`
    # rather than as one title among blanks.
    async def fake_source(config, source_id):
        return {
            "id": source_id,
            "properties": {
                "Priority": {
                    "type": "number"
                },
                "Name": {
                    "type": "title"
                },
            },
        }

    async def fake_query(config, source_id, body):
        return {
            "results": [{
                "id": "R2",
                "properties": {
                    "Name": {
                        "type": "title",
                        "title": [{
                            "plain_text": "Row page"
                        }],
                    },
                },
            }],
            "has_more":
            False,
        }

    monkeypatch.setitem(query.__globals__, "get_data_source", fake_source)
    monkeypatch.setitem(query.__globals__, "query_data_source_page",
                        fake_query)
    out, _io = await query(CLIInvocation(CONFIG, texts=("S1", ), flags={}))
    assert await _text(out) == "R2\tRow page\n"


@pytest.mark.asyncio
async def test_datasources_query_reports_the_next_cursor(monkeypatch):

    async def fake_source(config, source_id):
        return {"id": source_id, "properties": {}}

    async def fake_query(config, source_id, body):
        return {"results": [], "has_more": True, "next_cursor": "7"}

    monkeypatch.setitem(query.__globals__, "get_data_source", fake_source)
    monkeypatch.setitem(query.__globals__, "query_data_source_page",
                        fake_query)
    _out, io = await query(CLIInvocation(CONFIG, texts=("S1", )))
    assert (await materialize(io.stderr)).decode() == (
        "\nMore results available. Use --start-cursor 7 to continue.\n")


@pytest.mark.asyncio
async def test_datasources_query_follows_a_database_id(monkeypatch):
    from mirage.core.notion._client import NotionAPIError

    seen = []

    async def fake_source(config, source_id):
        seen.append(source_id)
        if source_id == "D1":
            raise NotionAPIError("missing", status=404)
        return {"id": source_id, "properties": {}}

    async def fake_database(config, database_id):
        return {"data_sources": [{"id": "S1"}]}

    async def fake_query(config, source_id, body):
        return {"results": [], "has_more": False}

    monkeypatch.setitem(query.__globals__, "get_data_source", fake_source)
    monkeypatch.setitem(query.__globals__, "get_database", fake_database)
    monkeypatch.setitem(query.__globals__, "query_data_source_page",
                        fake_query)
    await query(CLIInvocation(CONFIG, texts=("D1", )))
    assert seen == ["D1", "S1"]


@pytest.mark.asyncio
async def test_auth_token_prints_the_configured_key():
    out, _io = await token(CLIInvocation(CONFIG))
    assert await _text(out) == "secret\n"


@pytest.mark.asyncio
async def test_whoami_renders_the_row(monkeypatch):

    async def fake_self(config):
        return WORKSPACE_OWNED

    monkeypatch.setitem(whoami.__globals__, "get_self", fake_self)
    out, _io = await whoami(CLIInvocation(CONFIG))
    assert await _text(out) == (
        "ID\tNAME\tbot\t\tWSID\tWSNAME\tWSID\tWSNAME\tworkspace\n")


def test_whoami_row_names_the_owning_user():
    # The last column is the owner's own kind, so a user owner reports
    # "person" rather than the "user" discriminator on the envelope.
    assert whoami_row(USER_OWNED).decode() == (
        "ID\tNAME\tbot\te@x.com\tWSID\tWSNAME\tOWNERID\tOWNERNAME\tperson\n")


@pytest.mark.asyncio
async def test_api_infers_method_and_strips_the_version_prefix(monkeypatch):
    gets = []
    posts = []

    async def fake_get(config, path, params=None, extra_headers=None):
        gets.append((path, params))
        return {"ok": True}

    async def fake_post(config,
                        path,
                        body=None,
                        extra_headers=None,
                        params=None):
        posts.append((path, body))
        return {"ok": True}

    monkeypatch.setitem(api.__globals__, "notion_get", fake_get)
    monkeypatch.setitem(api.__globals__, "notion_post", fake_post)
    monkeypatch.setitem(api.__globals__, "METHODS", {
        "GET": fake_get,
        "POST": fake_post
    })
    await api(CLIInvocation(CONFIG, texts=("v1/users/me", )))
    await api(CLIInvocation(CONFIG, texts=("v1/search", "query=Roadmap")))
    await api(
        CLIInvocation(CONFIG, texts=("v1/blocks/B1/children", "page_size==1")))
    assert gets[0] == ("/users/me", None)
    assert posts[0] == ("/search", {"query": "Roadmap"})
    assert gets[1] == ("/blocks/B1/children", {"page_size": "1"})


@pytest.mark.asyncio
async def test_api_builds_nested_bodies(monkeypatch):
    posts = []

    async def fake_post(config,
                        path,
                        body=None,
                        extra_headers=None,
                        params=None):
        posts.append(body)
        return {"ok": True}

    monkeypatch.setitem(api.__globals__, "notion_post", fake_post)
    monkeypatch.setitem(api.__globals__, "METHODS", {"POST": fake_post})
    await api(
        CLIInvocation(CONFIG,
                      texts=("v1/pages", "parent[page_id]=root",
                             "archived:=true")))
    assert posts[0] == {"parent": {"page_id": "root"}, "archived": True}


@pytest.mark.asyncio
async def test_api_prints_compact_sorted_json(monkeypatch):

    async def fake_get(config, path, params=None, extra_headers=None):
        return {"b": 1, "a": {"d": 2, "c": 3}}

    monkeypatch.setitem(api.__globals__, "notion_get", fake_get)
    out, _io = await api(CLIInvocation(CONFIG, texts=("v1/users/me", )))
    assert await _text(out) == '{"a":{"c":3,"d":2},"b":1}\n'
