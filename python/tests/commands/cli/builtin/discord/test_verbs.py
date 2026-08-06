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

from mirage.commands.cli.builtin.discord import (delete, edit, members, poll,
                                                 react, read, search, send,
                                                 server_info, thread_create)
from mirage.commands.cli.types import CLIInvocation
from mirage.core.discord.config import DiscordConfig
from mirage.io.types import materialize

CONFIG = DiscordConfig(token="bot-token")


async def _json(out):
    return json.loads(await materialize(out))


@pytest.mark.asyncio
async def test_send_forwards_reply_to(monkeypatch):
    calls = []

    async def fake_send(config, channel, text, reply_to):
        calls.append((channel, text, reply_to))
        return {"id": "M1"}

    monkeypatch.setitem(send.__globals__, "send_message", fake_send)
    await send(
        CLIInvocation(CONFIG,
                      flags={
                          "channel": "C1",
                          "text": "hi",
                          "reply_to": "M0"
                      }))
    assert calls == [("C1", "hi", "M0")]


@pytest.mark.asyncio
async def test_read_defaults_limit(monkeypatch):

    async def fake_fetch(config, channel, limit):
        return [{"id": "1", "content": f"{channel}:{limit}"}]

    monkeypatch.setitem(read.__globals__, "fetch_recent_messages", fake_fetch)
    out, _io = await read(CLIInvocation(CONFIG, flags={"channel": "C1"}))
    assert await _json(out) == [{"id": "1", "content": "C1:20"}]


@pytest.mark.asyncio
async def test_edit_and_delete(monkeypatch):

    async def fake_edit(config, channel, message, text):
        return {"id": message, "content": text}

    async def fake_delete(config, channel, message):
        return None

    monkeypatch.setitem(edit.__globals__, "edit_message", fake_edit)
    monkeypatch.setitem(delete.__globals__, "delete_message", fake_delete)
    out, _io = await edit(
        CLIInvocation(CONFIG,
                      flags={
                          "channel": "C1",
                          "message": "M1",
                          "text": "new"
                      }))
    assert (await _json(out))["content"] == "new"
    out, _io = await delete(
        CLIInvocation(CONFIG, flags={
            "channel": "C1",
            "message": "M1"
        }))
    assert (await _json(out))["ok"] is True


@pytest.mark.asyncio
async def test_react_returns_ok(monkeypatch):

    async def fake_react(config, channel, message, emoji):
        return None

    monkeypatch.setitem(react.__globals__, "add_reaction", fake_react)
    out, _io = await react(
        CLIInvocation(CONFIG,
                      flags={
                          "channel": "C1",
                          "message": "M1",
                          "emoji": "x"
                      }))
    assert (await _json(out))["ok"] is True


@pytest.mark.asyncio
async def test_search_forwards_channel_filter(monkeypatch):
    calls = []

    async def fake_search(config, guild, query, channel_id=None):
        calls.append((guild, query, channel_id))
        return [{"id": "M1"}]

    monkeypatch.setitem(search.__globals__, "search_guild", fake_search)
    out, _io = await search(
        CLIInvocation(CONFIG,
                      flags={
                          "guild": "G1",
                          "query": "q",
                          "channel": "C1"
                      }))
    assert calls == [("G1", "q", "C1")]
    assert await _json(out) == [{"id": "M1"}]


@pytest.mark.asyncio
async def test_thread_create_and_poll(monkeypatch):

    async def fake_thread(config, channel, name, message_id=None):
        return {"id": "T1", "name": name, "from": message_id}

    async def fake_poll(config, channel, question, answers, duration_hours,
                        multiselect):
        return {"id": "M9", "answers": answers, "hours": duration_hours}

    monkeypatch.setitem(thread_create.__globals__, "create_thread",
                        fake_thread)
    monkeypatch.setitem(poll.__globals__, "send_poll", fake_poll)
    out, _io = await thread_create(
        CLIInvocation(CONFIG,
                      flags={
                          "channel": "C1",
                          "name": "topic",
                          "message": "M1"
                      }))
    assert (await _json(out))["from"] == "M1"
    out, _io = await poll(
        CLIInvocation(CONFIG,
                      flags={
                          "channel": "C1",
                          "question": "Lunch?",
                          "answer": ["Pizza", "Sushi"]
                      }))
    data = await _json(out)
    assert data["answers"] == ["Pizza", "Sushi"]
    assert data["hours"] == 24


@pytest.mark.asyncio
async def test_members_and_server_info(monkeypatch):

    async def fake_list(config, guild):
        return [{"user": {"id": "U1"}}]

    async def fake_search(config, guild, query):
        return [{"user": {"id": "U2"}}]

    async def fake_get(config, endpoint):
        return {"id": endpoint.rsplit("/", 1)[-1]}

    monkeypatch.setitem(members.__globals__, "list_members", fake_list)
    monkeypatch.setitem(members.__globals__, "search_members", fake_search)
    monkeypatch.setitem(server_info.__globals__, "discord_get", fake_get)
    out, _io = await members(CLIInvocation(CONFIG, flags={"guild": "G1"}))
    assert await _json(out) == [{"user": {"id": "U1"}}]
    out, _io = await members(
        CLIInvocation(CONFIG, flags={
            "guild": "G1",
            "query": "al"
        }))
    assert await _json(out) == [{"user": {"id": "U2"}}]
    out, _io = await server_info(CLIInvocation(CONFIG, flags={"guild": "G1"}))
    assert (await _json(out))["id"] == "G1"
