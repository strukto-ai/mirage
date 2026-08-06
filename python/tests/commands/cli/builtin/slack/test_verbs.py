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

from mirage.commands.cli.builtin.slack import (emoji_list, list_members,
                                               list_pins, member_info,
                                               pin_message, react, reactions,
                                               read_messages, send_message,
                                               unpin_message)
from mirage.commands.cli.types import CLIInvocation
from mirage.core.slack.config import SlackConfig
from mirage.io.types import materialize

CONFIG = SlackConfig(token="xoxb-test")


async def _json(out):
    return json.loads(await materialize(out))


@pytest.mark.asyncio
async def test_send_message_threads_when_thread_ts_given(monkeypatch):
    calls = []

    async def fake_reply(config, channel, thread_ts, text):
        calls.append((channel, thread_ts, text))
        return {"ok": True}

    monkeypatch.setitem(send_message.__globals__, "reply_to_thread",
                        fake_reply)
    out, io = await send_message(
        CLIInvocation(CONFIG,
                      flags={
                          "channel": "C1",
                          "text": "hi",
                          "thread_ts": "9.9"
                      }))
    assert io.exit_code == 0
    assert calls == [("C1", "9.9", "hi")]


@pytest.mark.asyncio
async def test_read_messages_defaults_limit(monkeypatch):

    async def fake_fetch(config, channel, limit):
        return [{"ts": "1.0", "text": f"{channel}:{limit}"}]

    monkeypatch.setitem(read_messages.__globals__, "fetch_recent_messages",
                        fake_fetch)
    out, _io = await read_messages(
        CLIInvocation(CONFIG, flags={"channel": "C1"}))
    assert await _json(out) == [{"ts": "1.0", "text": "C1:20"}]


@pytest.mark.asyncio
async def test_react_and_reactions(monkeypatch):

    async def fake_add(config, channel, ts, emoji):
        return {"ok": True, "emoji": emoji}

    async def fake_get(config, channel, ts):
        return {"ts": ts, "reactions": []}

    monkeypatch.setitem(react.__globals__, "add_reaction", fake_add)
    monkeypatch.setitem(reactions.__globals__, "get_reactions", fake_get)
    out, _io = await react(
        CLIInvocation(CONFIG,
                      flags={
                          "channel": "C1",
                          "ts": "1.2",
                          "emoji": "tada"
                      }))
    assert (await _json(out))["emoji"] == "tada"
    out, _io = await reactions(
        CLIInvocation(CONFIG, flags={
            "channel": "C1",
            "ts": "1.2"
        }))
    assert (await _json(out))["ts"] == "1.2"


@pytest.mark.asyncio
async def test_pin_unpin_list(monkeypatch):

    async def fake_pin(config, channel, ts):
        return {"ok": True}

    async def fake_unpin(config, channel, ts):
        return {"ok": True}

    async def fake_list(config, channel):
        return [{"type": "message"}]

    monkeypatch.setitem(pin_message.__globals__, "pin_message_core", fake_pin)
    monkeypatch.setitem(unpin_message.__globals__, "unpin_message_core",
                        fake_unpin)
    monkeypatch.setitem(list_pins.__globals__, "list_pins_core", fake_list)
    out, _io = await pin_message(
        CLIInvocation(CONFIG, flags={
            "channel": "C1",
            "ts": "1.2"
        }))
    assert (await _json(out))["ok"] is True
    out, _io = await unpin_message(
        CLIInvocation(CONFIG, flags={
            "channel": "C1",
            "ts": "1.2"
        }))
    assert (await _json(out))["ok"] is True
    out, _io = await list_pins(CLIInvocation(CONFIG, flags={"channel": "C1"}))
    assert await _json(out) == [{"type": "message"}]


@pytest.mark.asyncio
async def test_member_info_and_list_members(monkeypatch):

    async def fake_profile(config, user):
        return {"id": user}

    async def fake_search(config, query):
        return [{"name": query}]

    async def fake_list(config):
        return [{"name": "everyone"}]

    monkeypatch.setitem(member_info.__globals__, "get_user_profile",
                        fake_profile)
    monkeypatch.setitem(list_members.__globals__, "search_users", fake_search)
    monkeypatch.setitem(list_members.__globals__, "list_users", fake_list)
    out, _io = await member_info(CLIInvocation(CONFIG, flags={"user": "U1"}))
    assert (await _json(out))["id"] == "U1"
    out, _io = await list_members(
        CLIInvocation(CONFIG, flags={"query": "alice"}))
    assert await _json(out) == [{"name": "alice"}]
    out, _io = await list_members(CLIInvocation(CONFIG))
    assert await _json(out) == [{"name": "everyone"}]


@pytest.mark.asyncio
async def test_emoji_list(monkeypatch):

    async def fake_emoji(config):
        return {"shipit": "url"}

    monkeypatch.setitem(emoji_list.__globals__, "list_emoji", fake_emoji)
    out, _io = await emoji_list(CLIInvocation(CONFIG))
    assert await _json(out) == {"shipit": "url"}
