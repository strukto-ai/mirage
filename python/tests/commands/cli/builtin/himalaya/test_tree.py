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
from mirage.commands.cli.builtin.himalaya import HIMALAYA, send
from mirage.io.types import materialize
from mirage.resource.email.config import EmailConfig

CONFIG = {
    "imap_host": "h",
    "smtp_host": "h",
    "username": "u",
    "password": "p",
}


def leaf(*path: str):
    node = HIMALAYA
    for name in path:
        node = next(c for c in node.subcommands if c.name == name)
    return node


def test_tree_shape_matches_the_himalaya_vocabulary():
    assert HIMALAYA.name == "himalaya"
    assert HIMALAYA.config_model is EmailConfig
    assert [g.name for g in HIMALAYA.subcommands] == ["envelope", "message"]
    assert [v.name for v in leaf("envelope").subcommands] == ["list"]
    assert [v.name for v in leaf("message").subcommands
            ] == ["read", "send", "reply", "forward"]


def test_write_classification_and_required_flags():
    assert not leaf("envelope", "list").write
    assert not leaf("message", "read").write
    for verb in ("send", "reply", "forward"):
        assert leaf("message", verb).write
    required = {
        option.long
        for option in leaf("message", "send").options if option.required
    }
    assert required == {"--to", "--subject", "--body"}
    assert all(not option.required
               for option in leaf("envelope", "list").options)


@pytest.mark.asyncio
async def test_installed_tree_dispatches_send(monkeypatch):

    async def fake_send(config, to, subject, body):
        return {"status": "sent", "to": to, "subject": subject}

    monkeypatch.setitem(send.__globals__, "send_message", fake_send)
    ws = Workspace({})
    ws.register_cli("himalaya", HIMALAYA, CONFIG)
    io = await ws.execute(
        "himalaya message send --to a@b.com --subject Hi --body yo")
    assert io.exit_code == 0
    out = json.loads(await materialize(io.stdout))
    assert out == {"status": "sent", "to": "a@b.com", "subject": "Hi"}
    await ws.close()


@pytest.mark.asyncio
async def test_missing_required_flag_exits_2():
    ws = Workspace({})
    ws.register_cli("himalaya", HIMALAYA, CONFIG)
    io = await ws.execute("himalaya message send --subject Hi --body yo")
    assert io.exit_code == 2
    err = await materialize(io.stderr)
    assert err.startswith(b"himalaya message send: option '--to' is required")
    await ws.close()


@pytest.mark.asyncio
async def test_unknown_verb_uses_git_wording():
    ws = Workspace({})
    ws.register_cli("himalaya", HIMALAYA, CONFIG)
    io = await ws.execute("himalaya bogus")
    assert io.exit_code == 1
    err = await materialize(io.stderr)
    assert err == (b"himalaya: 'bogus' is not a himalaya command. "
                   b"See 'himalaya --help'.\n")
    await ws.close()
