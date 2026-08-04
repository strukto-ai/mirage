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
from mirage.commands.cli.builtin.slack import SLACK, send_message
from mirage.core.slack.config import SlackConfig
from mirage.io.types import materialize

CONFIG = {"token": "xoxb-test"}

VERBS = [
    "send-message",
    "read-messages",
    "react",
    "reactions",
    "pin-message",
    "unpin-message",
    "list-pins",
    "member-info",
    "list-members",
    "emoji-list",
    "search",
]


def leaf(name: str):
    return next(c for c in SLACK.subcommands if c.name == name)


def test_tree_shape_matches_the_openclaw_vocabulary():
    assert SLACK.name == "slack"
    assert SLACK.config_model is SlackConfig
    assert [v.name for v in SLACK.subcommands] == VERBS


def test_write_classification():
    writers = {v.name for v in SLACK.subcommands if v.write}
    assert writers == {
        "send-message",
        "react",
        "pin-message",
        "unpin-message",
    }


def test_required_flags():
    required = {o.long for o in leaf("send-message").options if o.required}
    assert required == {"--channel", "--text"}
    assert not any(o.required for o in leaf("emoji-list").options)


@pytest.mark.asyncio
async def test_installed_tree_dispatches_send_message(monkeypatch):

    async def fake_post(config, channel, text):
        return {"ok": True, "channel": channel, "ts": "1.2", "text": text}

    monkeypatch.setitem(send_message.__globals__, "post_message", fake_post)
    ws = Workspace({})
    ws.register_cli("slack", SLACK, CONFIG)
    io = await ws.execute('slack send-message --channel C001 --text hello')
    assert io.exit_code == 0
    out = json.loads(await materialize(io.stdout))
    assert out["channel"] == "C001"
    await ws.close()


@pytest.mark.asyncio
async def test_missing_required_flag_exits_2():
    ws = Workspace({})
    ws.register_cli("slack", SLACK, CONFIG)
    io = await ws.execute("slack send-message --text hi")
    assert io.exit_code == 2
    await ws.close()
