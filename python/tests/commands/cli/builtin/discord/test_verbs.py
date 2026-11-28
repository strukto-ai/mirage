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

from mirage.commands.cli.builtin.discord import (
    DISCORD,
    delete_verb,
    edit,
    members,
    poll,
    react,
    read,
    search,
    send,
    server_info,
    thread_create,
)
from mirage.commands.config import Context
from mirage.commands.spec.types import FlagValue
from mirage.io.types import materialize
from mirage.types import PathSpec
from tests.fixtures.discord_guild import (
    DAY,
    GENERAL,
    GUILD,
    MESSAGES,
    SEARCH,
)


def _ctx(leaf: str, **flags: FlagValue) -> Context:
    spec = next(s for s in DISCORD.spec.subcommands if s.name == leaf)
    return Context(flags=flags, spec=spec)


async def _json(out):
    return json.loads(await materialize(out))


async def _hello(guild) -> str:
    [hello, _] = await guild.day(GENERAL, DAY)
    return hello["id"]


@pytest.mark.asyncio
async def test_send_forwards_reply_to(discord_guild):
    hello = await _hello(discord_guild)
    await send(
        discord_guild.accessor(),
        [],
        [],
        _ctx("send", channel=GENERAL, text="hi", reply_to=hello),
    )
    assert await discord_guild.run.bodies("POST", MESSAGES) == [
        {"content": "hi", "message_reference": {"message_id": hello}}
    ]


class _Files:
    async def read(self, path: PathSpec) -> bytes:
        if path.virtual != "/tmp/reply.wav":
            raise FileNotFoundError(2, "No such file", path.virtual)
        return b"RIFF"


@pytest.mark.asyncio
async def test_send_attaches_the_workspace_file(discord_guild):
    spec = next(s for s in DISCORD.spec.subcommands if s.name == "send")
    ctx = Context(
        flags={
            "channel": GENERAL,
            "text": "",
            "file": PathSpec.from_str_path("/tmp/reply.wav"),
        },
        spec=spec,
        vfs=_Files(),
    )
    out, _io = await send(discord_guild.accessor(), [], [], ctx)
    sent = await _json(out)
    [attached] = (await discord_guild.message(GENERAL, sent["id"]))[
        "attachments"
    ]
    assert attached["filename"] == "reply.wav"
    path = attached["url"].split("/attachments/", 1)[1].split("?", 1)[0]
    assert await discord_guild.run.read(f"/attachments/{path}") == b"RIFF"


@pytest.mark.asyncio
async def test_read_defaults_limit(discord_guild):
    out, _io = await read(
        discord_guild.accessor(), [], [], _ctx("read", channel=GENERAL)
    )
    assert [m["content"] for m in await _json(out)] == [
        "hello",
        "files",
        "morning",
    ]
    [params] = await discord_guild.run.params("GET", MESSAGES)
    assert params["limit"] == "20"


@pytest.mark.asyncio
async def test_edit_and_delete(discord_guild):
    # A bot may edit and delete only what it posted.
    mine = await discord_guild.post(GENERAL, "draft")
    accessor = discord_guild.accessor()
    out, _io = await edit(
        accessor,
        [],
        [],
        _ctx("edit", channel=GENERAL, message=mine["id"], text="new"),
    )
    assert (await _json(out))["content"] == "new"
    out, _io = await delete_verb(
        accessor, [], [], _ctx("delete", channel=GENERAL, message=mine["id"])
    )
    assert (await _json(out))["ok"] is True
    gone = f"/api/v10/channels/{GENERAL}/messages/{mine['id']}"
    async with discord_guild.run.http.get(discord_guild.run.url + gone) as r:
        assert r.status == 404


@pytest.mark.asyncio
async def test_react_returns_ok(discord_guild):
    hello = await _hello(discord_guild)
    out, _io = await react(
        discord_guild.accessor(),
        [],
        [],
        _ctx("react", channel=GENERAL, message=hello, emoji="x"),
    )
    assert (await _json(out))["ok"] is True
    reacted = await discord_guild.message(GENERAL, hello)
    assert [r["emoji"]["name"] for r in reacted["reactions"]] == ["x"]


@pytest.mark.asyncio
async def test_search_forwards_channel_filter(discord_guild):
    out, _io = await search(
        discord_guild.accessor(),
        [],
        [],
        _ctx("search", guild=GUILD, query="o", channel=GENERAL),
    )
    [params] = await discord_guild.run.params("GET", SEARCH)
    assert (params["content"], params["channel_id"]) == ("o", GENERAL)
    # random's chatter matches too, outside the channel asked for.
    assert [m["content"] for m in await _json(out)] == ["hello", "morning"]


@pytest.mark.asyncio
async def test_thread_create_and_poll(discord_guild):
    hello = await _hello(discord_guild)
    accessor = discord_guild.accessor()
    out, _io = await thread_create(
        accessor,
        [],
        [],
        _ctx("thread-create", channel=GENERAL, name="topic", message=hello),
    )
    thread = await _json(out)
    assert (thread["name"], thread["parent_id"]) == ("topic", GENERAL)
    out, _io = await poll(
        accessor,
        [],
        [],
        _ctx(
            "poll",
            channel=GENERAL,
            question="Lunch?",
            answer=["Pizza", "Sushi"],
        ),
    )
    sent = (await _json(out))["poll"]
    assert [a["poll_media"]["text"] for a in sent["answers"]] == [
        "Pizza",
        "Sushi",
    ]
    [body] = await discord_guild.run.bodies("POST", MESSAGES)
    assert body["poll"]["duration"] == 24


@pytest.mark.asyncio
async def test_members_and_server_info(discord_guild):
    accessor = discord_guild.accessor()
    out, _io = await members(accessor, [], [], _ctx("members", guild=GUILD))
    assert [m["user"]["username"] for m in await _json(out)] == [
        "alice",
        "bob",
        "mirage-bot",
    ]
    out, _io = await members(
        accessor, [], [], _ctx("members", guild=GUILD, query="al")
    )
    assert [m["user"]["username"] for m in await _json(out)] == ["alice"]
    out, _io = await server_info(
        accessor, [], [], _ctx("server-info", guild=GUILD)
    )
    assert (await _json(out))["id"] == GUILD
