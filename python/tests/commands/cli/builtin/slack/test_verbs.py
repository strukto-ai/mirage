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

from mirage.commands.cli.builtin.slack import (
    SLACK,
    emoji_list,
    list_members,
    list_pins,
    member_info,
    pin_message,
    react,
    reactions,
    read_messages,
    search,
    send_message,
    unpin_message,
)
from mirage.commands.config import Context
from mirage.io.types import materialize
from tests.fixtures.slack_workspace import HISTORY, POST, SEARCH_MESSAGES

# "lunch at noon" in general, which ana reacted to with a rocket.
LUNCH = "1762214460.000001"


def _ctx(leaf: str, **flags) -> Context:
    spec = next(s for s in SLACK.spec.subcommands if s.name == leaf)
    return Context(flags=flags, spec=spec)


async def _json(out):
    return json.loads(await materialize(out))


@pytest.mark.asyncio
async def test_send_message_threads_when_thread_ts_given(slack_workspace):
    out, io = await send_message(
        slack_workspace.accessor(),
        [],
        [],
        _ctx("send-message", channel="C1", text="hi", thread_ts=LUNCH),
    )
    assert io.exit_code == 0
    [sent] = await slack_workspace.run.bodies("POST", POST)
    assert (sent["channel"], sent["text"], sent["thread_ts"]) == (
        "C1",
        "hi",
        LUNCH,
    )
    posted = (await _json(out))["ts"]
    assert any(
        m["ts"] == posted and m.get("thread_ts") == LUNCH
        for m in await slack_workspace.history("C1")
    )


@pytest.mark.asyncio
async def test_read_messages_defaults_limit(slack_workspace):
    out, _io = await read_messages(
        slack_workspace.accessor(), [], [], _ctx("read-messages", channel="C1")
    )
    texts = [m["text"] for m in await _json(out)]
    assert texts[:2] == ["the deploy is done at acme", "coffee is ready"]
    [params] = await slack_workspace.run.params("GET", HISTORY)
    assert (params["channel"], params["limit"]) == ("C1", "20")


@pytest.mark.asyncio
async def test_read_messages_keeps_an_explicit_zero_limit(slack_workspace):
    await read_messages(
        slack_workspace.accessor(),
        [],
        [],
        Context(flags={"channel": "C1", "limit": 0}),
    )
    [params] = await slack_workspace.run.params("GET", HISTORY)
    assert params["limit"] == "0"


@pytest.mark.asyncio
async def test_search_keeps_an_explicit_zero_count_and_page(slack_workspace):
    accessor = slack_workspace.accessor()
    await search(
        accessor, [], [], Context(flags={"query": "q", "count": 0, "page": 0})
    )
    await search(accessor, [], [], Context(flags={"query": "q"}))
    asked = await slack_workspace.run.params("GET", SEARCH_MESSAGES)
    assert [(p["query"], p["count"], p["page"]) for p in asked] == [
        ("q", "0", "0"),
        ("q", "20", "1"),
    ]


@pytest.mark.asyncio
async def test_react_and_reactions(slack_workspace):
    accessor = slack_workspace.accessor()
    out, _io = await react(
        accessor,
        [],
        [],
        _ctx("react", channel="C1", ts=LUNCH, emoji="tada"),
    )
    assert (await _json(out))["ok"] is True
    out, _io = await reactions(
        accessor, [], [], _ctx("reactions", channel="C1", ts=LUNCH)
    )
    message = await _json(out)
    assert message["ts"] == LUNCH
    assert [r["name"] for r in message["reactions"]] == ["rocket", "tada"]


@pytest.mark.asyncio
async def test_pin_unpin_list(slack_workspace):
    accessor = slack_workspace.accessor()
    out, _io = await pin_message(
        accessor, [], [], _ctx("pin-message", channel="C1", ts=LUNCH)
    )
    assert (await _json(out))["ok"] is True
    out, _io = await list_pins(
        accessor, [], [], _ctx("list-pins", channel="C1")
    )
    assert [item["message"]["ts"] for item in await _json(out)] == [LUNCH]
    out, _io = await unpin_message(
        accessor, [], [], _ctx("unpin-message", channel="C1", ts=LUNCH)
    )
    assert (await _json(out))["ok"] is True
    out, _io = await list_pins(
        accessor, [], [], _ctx("list-pins", channel="C1")
    )
    assert await _json(out) == []


@pytest.mark.asyncio
async def test_member_info_and_list_members(slack_workspace):
    accessor = slack_workspace.accessor()
    out, _io = await member_info(
        accessor, [], [], _ctx("member-info", user="U1")
    )
    assert (await _json(out))["name"] == "ana"
    out, _io = await list_members(
        accessor, [], [], _ctx("list-members", query="ana")
    )
    assert [u["name"] for u in await _json(out)] == ["ana"]
    out, _io = await list_members(accessor, [], [], _ctx("list-members"))
    assert [u["name"] for u in await _json(out)] == ["ana", "ben"]


@pytest.mark.asyncio
async def test_emoji_list(slack_workspace):
    out, _io = await emoji_list(
        slack_workspace.accessor(), [], [], _ctx("emoji-list")
    )
    assert await _json(out) == {
        "shipit": "https://emoji.example/shipit.png",
        "partyparrot": "alias:parrot",
    }
