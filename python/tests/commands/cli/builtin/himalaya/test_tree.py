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

from email.parser import BytesParser
from email.policy import default as default_policy

import pytest

from mirage import Workspace
from mirage.commands.cli.builtin.himalaya import HIMALAYA
from mirage.commands.cli.builtin.himalaya import util as util_module
from mirage.core.email.config import EmailConfig
from mirage.io.types import materialize

CONFIG = {
    "imap_host": "h",
    "smtp_host": "h",
    "username": "me@example.com",
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
    assert [v.name for v in leaf("envelope").subcommands] == ["list", "search"]
    assert [v.name for v in leaf("message").subcommands
            ] == ["read", "compose", "send", "reply", "forward"]


def test_upstream_aliases_resolve():
    assert leaf("envelope", "list").aliases == ("ls", )
    assert leaf("envelope", "search").aliases == ("sr", )
    assert leaf("message", "compose").aliases == ("write", "new")
    assert leaf("message", "forward").aliases == ("fwd", )


def test_the_mailbox_is_a_flag_and_the_message_id_is_an_operand():
    for verb in ("read", "reply", "forward"):
        node = leaf("message", verb)
        assert node.rest is not None
        mailbox = next(o for o in node.options if o.long == "--mailbox")
        assert mailbox.short == "-m"
    assert leaf("message", "compose").rest is None


def test_no_composer_flag_is_required_since_compose_can_read_stdin():
    assert all(not option.required
               for option in leaf("message", "compose").options)


def test_write_classification_splits_reads_from_sends():
    assert not leaf("envelope", "list").write
    assert not leaf("envelope", "search").write
    assert not leaf("message", "read").write
    for verb in ("compose", "send", "reply", "forward"):
        assert leaf("message", verb).write


@pytest.mark.asyncio
async def test_installed_tree_composes_mime_without_sending():
    ws = Workspace({})
    ws.register_cli("himalaya", HIMALAYA, CONFIG)
    io = await ws.execute(
        "himalaya message compose --to a@b.com --subject Hi --body yo")
    assert io.exit_code == 0
    message = BytesParser(policy=default_policy).parsebytes(await materialize(
        io.stdout))
    assert message["To"] == "a@b.com"
    assert message["Subject"] == "Hi"
    await ws.close()


@pytest.mark.asyncio
async def test_the_write_alias_reaches_compose(monkeypatch):
    sent = {}

    async def fake_send_raw(config, raw):
        sent["raw"] = raw
        return BytesParser(policy=default_policy).parsebytes(raw)

    monkeypatch.setattr(util_module, "send_raw", fake_send_raw)
    ws = Workspace({})
    ws.register_cli("himalaya", HIMALAYA, CONFIG)
    io = await ws.execute(
        "himalaya message write --to a@b.com --subject Hi --body yo --send")
    assert io.exit_code == 0
    assert b"Subject: Hi" in sent["raw"]
    await ws.close()


@pytest.mark.asyncio
async def test_a_missing_message_id_exits_1_with_the_leaf_message():
    ws = Workspace({})
    ws.register_cli("himalaya", HIMALAYA, CONFIG)
    io = await ws.execute("himalaya message read")
    assert io.exit_code == 1
    err = await materialize(io.stderr)
    assert b"message id is required" in err
    await ws.close()


@pytest.mark.asyncio
async def test_an_upstream_verb_mirage_lacks_fails_loud():
    ws = Workspace({})
    ws.register_cli("himalaya", HIMALAYA, CONFIG)
    io = await ws.execute("himalaya message move 7 --to Archive")
    assert io.exit_code == 1
    err = await materialize(io.stderr)
    assert err == (b"himalaya: 'move' is not a himalaya message command. "
                   b"See 'himalaya message --help'.\n")
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
