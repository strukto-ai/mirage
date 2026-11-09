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

import itertools
import sys
from email.parser import BytesParser
from email.policy import default as default_policy

import pytest

from mirage import Workspace
from mirage.commands.cli.builtin.himalaya import HIMALAYA
from mirage.commands.cli.builtin.himalaya import util as util_module
from mirage.commands.spec.compile import compile_spec
from mirage.core.email.config import EmailConfig
from mirage.io.types import materialize
from mirage.vfs.email.email import EmailVFS

CONFIG = {
    "imap_host": "h",
    "smtp_host": "h",
    "username": "me@example.com",
    "password": "p",
}


def leaf(*path: str):
    node = HIMALAYA.spec
    for name in path:
        node = next(c for c in node.subcommands if c.name == name)
    return node


def test_tree_shape_matches_the_himalaya_vocabulary():
    assert HIMALAYA.spec.name == "himalaya"
    assert HIMALAYA.config_model is EmailConfig
    assert [g.name for g in HIMALAYA.spec.subcommands] == [
        "mailbox",
        "flag",
        "attachment",
        "envelope",
        "message",
    ]
    assert [v.name for v in leaf("envelope").subcommands] == ["list", "search"]
    assert [v.name for v in leaf("message").subcommands] == [
        "copy",
        "move",
        "delete",
        "read",
        "compose",
        "send",
        "add",
        "reply",
        "forward",
    ]


def test_upstream_aliases_resolve():
    assert leaf("envelope", "list").aliases == ("ls",)
    assert leaf("envelope", "search").aliases == ("sr",)
    assert leaf("message", "compose").aliases == ("write", "new")
    assert leaf("message", "forward").aliases == ("fwd",)


def test_the_mailbox_is_a_flag_and_the_message_id_is_an_operand():
    for verb in ("read", "reply", "forward"):
        node = leaf("message", verb)
        assert [o.names for o in compile_spec(node).positional] == [("ID",)]
        mailbox = next(
            o for o in compile_spec(node).options if "--mailbox" in o.names
        )
        assert "-m" in mailbox.names
    assert compile_spec(leaf("message", "compose")).rest is None


def test_no_composer_flag_is_required_since_compose_can_read_stdin():
    assert all(
        not option.required
        for option in compile_spec(leaf("message", "compose")).options
    )


def test_write_classification_splits_reads_from_sends():
    assert not HIMALAYA.handlers["envelope list"].write
    assert not HIMALAYA.handlers["envelope search"].write
    assert not HIMALAYA.handlers["message read"].write
    for verb in ("compose", "send", "reply", "forward"):
        assert HIMALAYA.handlers[
            " ".join(
                (
                    "message",
                    verb,
                )
            )
        ].write


@pytest.mark.asyncio
async def test_installed_tree_composes_mime_without_sending():
    ws = Workspace({})
    ws.register_cli("himalaya", HIMALAYA, CONFIG)
    io = await ws.shell(
        "himalaya message compose --to a@b.com --subject Hi --body yo"
    )
    assert io.exit_code == 0
    message = BytesParser(policy=default_policy).parsebytes(
        await materialize(io.stdout)
    )
    assert message["To"] == "a@b.com"
    assert message["Subject"] == "Hi"
    await ws.close()


@pytest.mark.asyncio
async def test_the_write_alias_reaches_compose(monkeypatch):
    sent = {}

    async def fake_deliver(accessor, raw, save=None, no_save=False):
        sent["raw"] = raw
        return BytesParser(policy=default_policy).parsebytes(raw), False

    monkeypatch.setattr(util_module, "deliver", fake_deliver)
    ws = Workspace({})
    ws.register_cli("himalaya", HIMALAYA, CONFIG)
    io = await ws.shell(
        "himalaya message write --to a@b.com --subject Hi --body yo --send"
    )
    assert io.exit_code == 0
    assert b"Subject: Hi" in sent["raw"]
    await ws.close()


@pytest.mark.asyncio
async def test_a_missing_message_id_is_refused_the_way_clap_refuses_it():
    ws = Workspace({})
    ws.register_cli("himalaya", HIMALAYA, CONFIG)
    io = await ws.shell("himalaya message read")
    assert io.exit_code == 2
    err = await materialize(io.stderr)
    assert err == (
        b"error: the following required arguments were not provided:\n"
        b"  <ID>\n\nUsage: himalaya message read <ID>\n\n"
        b"For more information, try '--help'.\n"
    )
    await ws.close()


@pytest.mark.asyncio
async def test_a_stray_operand_of_a_dash_dash_only_slot_is_refused():
    ws = Workspace({})
    ws.register_cli("himalaya", HIMALAYA, CONFIG)
    io = await ws.shell("himalaya message add 7")
    assert io.exit_code == 2
    err = await materialize(io.stderr)
    assert err == (
        b"error: unexpected argument '7' found\n\n"
        b"Usage: himalaya message add [OPTIONS] --mailbox <NAME> "
        b"[-- <MESSAGE>...]\n\n"
        b"For more information, try '--help'.\n"
    )
    await ws.close()


@pytest.mark.asyncio
async def test_an_unknown_verb_is_refused_the_way_clap_refuses_it():
    ws = Workspace({})
    ws.register_cli("himalaya", HIMALAYA, CONFIG)
    io = await ws.shell("himalaya bogus")
    assert io.exit_code == 2
    err = await materialize(io.stderr)
    assert err == (
        b"error: unrecognized subcommand 'bogus'\n\n"
        b"Usage: himalaya [OPTIONS] [COMMAND]\n\n"
        b"For more information, try '--help'.\n"
    )
    await ws.close()


def _header(uid: str, subject: str) -> dict:
    return {
        "uid": uid,
        "subject": subject,
        "from": {"name": "", "email": "me@example.com"},
        "reply_to": [],
        "to": [],
        "cc": [],
        "date": "Mon, 14 Sep 2026 10:00:00 +0000",
        "internal_date": "14-Sep-2026 10:00:00 +0000",
        "body_text": "",
        "body_html": "",
        "snippet": "",
        "message_id": f"<{uid}@example.com>",
        "in_reply_to": None,
        "references": [],
        "has_attachments": False,
        "attachments": [],
        "flags": [],
    }


@pytest.fixture
def mailbox(monkeypatch):
    # The CLI and a mount are two entry points to one account, so a message the
    # CLI files has to show in the mount's listing without waiting out
    # the index TTL. The mailbox here is test state; the VFS, the
    # CLI, the workspace and its caches are the real ones.
    readdir_module = sys.modules["mirage.core.email.readdir"]
    store: dict[str, list[str]] = {}
    headers: dict[str, dict] = {}
    listed: list[str] = []
    uids = itertools.count(101)

    def file(folder: str, raw: bytes) -> None:
        message = BytesParser(policy=default_policy).parsebytes(raw)
        uid = str(next(uids))
        headers[uid] = _header(uid, message["Subject"] or "")
        store.setdefault(folder, []).append(uid)

    async def list_folders(accessor):
        return ["INBOX", "Sent"]

    async def list_uids(
        accessor, folder, search_criteria="ALL", max_results=None
    ):
        listed.append(folder)
        return list(store.get(folder, []))

    async def fetch_headers(accessor, folder, uids):
        return [headers[uid] for uid in uids]

    async def save(accessor, raw, folder=None):
        file(folder or "Sent", raw)
        return folder or "Sent"

    async def deliver(accessor, raw, save=None, no_save=False):
        if save is not None:
            file(save, raw)
        return BytesParser(policy=default_policy).parsebytes(
            raw
        ), save is not None

    monkeypatch.setattr(readdir_module, "list_folders", list_folders)
    monkeypatch.setattr(readdir_module, "list_message_uids", list_uids)
    monkeypatch.setattr(readdir_module, "fetch_headers", fetch_headers)
    monkeypatch.setattr(util_module, "save_sent_copy", save)
    monkeypatch.setattr(util_module, "deliver", deliver)
    file("INBOX", b"Subject: Older\r\n\r\n")
    return listed


def mounted() -> Workspace:
    ws = Workspace(
        {
            "/mail": EmailVFS(config=EmailConfig(**CONFIG)),
            "/alias": EmailVFS(config=EmailConfig(**CONFIG)),
        }
    )
    ws.register_cli("himalaya", HIMALAYA, CONFIG)
    return ws


async def out(ws: Workspace, line: str) -> str:
    io = await ws.shell(line)
    assert io.exit_code == 0, await materialize(io.stderr)
    return (await materialize(io.stdout)).decode()


@pytest.mark.asyncio
async def test_a_saved_message_reaches_every_listed_mount_of_the_account(
    mailbox,
):
    ws = mounted()
    try:
        assert await out(ws, "ls /mail/Sent") == ""
        assert await out(ws, "ls /alias/Sent") == ""
        await out(
            ws,
            "himalaya message compose --to r@example.invalid "
            "--subject Example --body Hello --save Sent",
        )
        assert await out(ws, "ls /mail/Sent") == "2026-09-14\n"
        assert "/alias/Sent/2026-09-14/Example__102.email.json\n" in await out(
            ws, "find /alias -type f"
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_sent_copy_lands_in_a_listed_folder_that_already_had_mail(
    mailbox,
):
    ws = mounted()
    try:
        assert (
            await out(ws, "ls /mail/INBOX/2026-09-14")
            == "Older__101.email.json\n"
        )
        await out(
            ws,
            "himalaya message compose --to r@example.invalid "
            "--subject Copy --body Hello --send --save INBOX",
        )
        assert await out(ws, "ls /mail/INBOX/2026-09-14") == (
            "Copy__102.email.json\nOlder__101.email.json\n"
        )
    finally:
        await ws.close()
