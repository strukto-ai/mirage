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
from mirage.commands.cli.builtin.discord import DISCORD, send
from mirage.core.discord.config import DiscordConfig
from mirage.io.types import materialize

CONFIG = {"token": "bot-token"}

VERBS = [
    "send",
    "read",
    "edit",
    "delete",
    "react",
    "search",
    "thread-create",
    "poll",
    "members",
    "server-info",
]


def leaf(name: str):
    return next(c for c in DISCORD.subcommands if c.name == name)


def test_tree_shape_matches_the_openclaw_vocabulary():
    assert DISCORD.name == "discord"
    assert DISCORD.config_model is DiscordConfig
    assert [v.name for v in DISCORD.subcommands] == VERBS


def test_write_classification():
    writers = {v.name for v in DISCORD.subcommands if v.write}
    assert writers == {
        "send",
        "edit",
        "delete",
        "react",
        "thread-create",
        "poll",
    }


def test_poll_answer_flag_is_repeatable():
    answer = next(o for o in leaf("poll").options if o.long == "--answer")
    assert answer.multiple
    assert answer.required


@pytest.mark.asyncio
async def test_installed_tree_dispatches_send(monkeypatch):

    async def fake_send(config, channel, text, reply_to):
        return {"id": "M1", "channel_id": channel, "content": text}

    monkeypatch.setitem(send.__globals__, "send_message", fake_send)
    ws = Workspace({})
    ws.register_cli("discord", DISCORD, CONFIG)
    io = await ws.execute("discord send --channel C1 --text hello")
    assert io.exit_code == 0
    out = json.loads(await materialize(io.stdout))
    assert out["content"] == "hello"
    await ws.close()
