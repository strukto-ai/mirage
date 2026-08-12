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
from unittest.mock import AsyncMock, MagicMock

import pytest

from mirage.accessor.email import EmailAccessor
from mirage.commands.cli.builtin.himalaya.deliver import (deliver,
                                                          resolve_sent_folder,
                                                          save_sent_copy)
from mirage.core.email.config import EmailConfig

RAW = b"From: me@example.com\r\nTo: a@b.com\r\nSubject: Hi\r\n\r\nyo"

GMAIL_LINES = [
    b'(\\HasNoChildren) "/" "INBOX"',
    b'(\\HasNoChildren \\Sent) "/" "[Gmail]/Sent Mail"',
    b'(\\HasNoChildren \\Trash) "/" "[Gmail]/Trash"',
]
PLAIN_LINES = [
    b'(\\HasNoChildren) "/" "INBOX"',
    b'(\\HasNoChildren) "/" "Archive"',
]


def config(**overrides) -> EmailConfig:
    return EmailConfig(imap_host="h",
                       smtp_host="h",
                       username="u",
                       password="p",
                       **overrides)


def fake_imap(lines: list[bytes], append_result: str = "OK"):
    imap = AsyncMock()
    listing = MagicMock()
    listing.lines = lines
    imap.list.return_value = listing
    appended = MagicMock()
    appended.result = append_result
    appended.lines = [b"[TRYCREATE] No such mailbox"]
    imap.append.return_value = appended
    return imap


@pytest.fixture
def imap(monkeypatch):
    state: dict = {"lines": PLAIN_LINES, "append_result": "OK"}

    async def fake_get_imap(self):
        client = state.setdefault(
            "client", fake_imap(state["lines"], state["append_result"]))
        return client

    async def fake_close(self):
        state["closed"] = True

    monkeypatch.setattr(EmailAccessor, "get_imap", fake_get_imap)
    monkeypatch.setattr(EmailAccessor, "close", fake_close)
    return state


@pytest.fixture
def smtp(monkeypatch):
    seen: dict = {}

    async def fake_send_raw(cfg, raw):
        seen["raw"] = raw
        return BytesParser(policy=default_policy).parsebytes(raw)

    monkeypatch.setitem(deliver.__globals__, "send_raw", fake_send_raw)
    return seen


@pytest.mark.asyncio
async def test_the_server_names_its_own_sent_mailbox(imap):
    imap["lines"] = GMAIL_LINES
    accessor = EmailAccessor(config())
    assert await resolve_sent_folder(accessor, None) == "[Gmail]/Sent Mail"


@pytest.mark.asyncio
async def test_a_server_with_no_tag_falls_back_to_sent(imap):
    accessor = EmailAccessor(config())
    assert await resolve_sent_folder(accessor, None) == "Sent"


@pytest.mark.asyncio
async def test_a_configured_folder_beats_the_servers_tag(imap):
    imap["lines"] = GMAIL_LINES
    accessor = EmailAccessor(config())
    assert await resolve_sent_folder(accessor, "Archive") == "Archive"


@pytest.mark.asyncio
async def test_a_configured_folder_is_taken_without_asking(imap):
    accessor = EmailAccessor(config())
    assert await resolve_sent_folder(accessor, "Archive") == "Archive"
    assert "client" not in imap


@pytest.mark.asyncio
async def test_the_copy_is_appended_seen_and_the_mailbox_is_quoted(imap):
    imap["lines"] = GMAIL_LINES
    assert await save_sent_copy(config(), RAW) == "[Gmail]/Sent Mail"
    # A mailbox name holding a space is two arguments unless it is
    # quoted, and both Gmail's and Exchange's hold one.
    imap["client"].append.assert_awaited_once_with(
        RAW, mailbox='"[Gmail]/Sent Mail"', flags="\\Seen")
    assert imap["closed"] is True


@pytest.mark.asyncio
async def test_a_refused_append_names_the_mailbox(imap):
    imap["append_result"] = "NO"
    with pytest.raises(ValueError, match="Sent: .*TRYCREATE"):
        await save_sent_copy(config(), RAW)
    assert imap["closed"] is True


@pytest.mark.asyncio
async def test_deliver_sends_then_saves(imap, smtp):
    message, warning = await deliver(config(), RAW)
    assert smtp["raw"] == RAW
    assert message["Subject"] == "Hi"
    assert warning == ""
    imap["client"].append.assert_awaited_once()


@pytest.mark.asyncio
async def test_save_copy_off_sends_and_touches_no_mailbox(imap, smtp):
    _, warning = await deliver(config(save_copy=False), RAW)
    assert smtp["raw"] == RAW
    assert warning == ""
    assert "client" not in imap


@pytest.mark.asyncio
async def test_a_failed_copy_warns_but_the_send_still_counts(imap, smtp):
    imap["append_result"] = "NO"
    message, warning = await deliver(config(), RAW)
    # The message is already on the wire, so the copy's failure is
    # reported rather than raised: a non-zero exit invites a retry that
    # would send it a second time.
    assert smtp["raw"] == RAW
    assert message["Subject"] == "Hi"
    assert warning.startswith("himalaya: sent copy not saved: Sent:")
    assert warning.endswith("\n")


@pytest.mark.asyncio
async def test_a_broken_connection_warns_rather_than_raising(
        monkeypatch, smtp):

    async def fake_get_imap(self):
        raise ConnectionError("IMAP login failed for u on h")

    async def fake_close(self):
        return None

    monkeypatch.setattr(EmailAccessor, "get_imap", fake_get_imap)
    monkeypatch.setattr(EmailAccessor, "close", fake_close)
    _, warning = await deliver(config(), RAW)
    assert warning == ("himalaya: sent copy not saved: "
                       "IMAP login failed for u on h\n")


@pytest.mark.asyncio
async def test_save_names_the_mailbox_and_skips_resolution(imap):
    imap["lines"] = GMAIL_LINES
    assert await save_sent_copy(config(), RAW, "Drafts") == "Drafts"
    imap["client"].append.assert_awaited_once_with(RAW,
                                                   mailbox='"Drafts"',
                                                   flags="\\Seen")
    imap["client"].list.assert_not_awaited()


@pytest.mark.asyncio
async def test_save_beats_the_accounts_own_sent_mailbox(imap, smtp):
    imap["lines"] = GMAIL_LINES
    _, warning = await deliver(config(), RAW, "Drafts")
    assert warning == ""
    imap["client"].append.assert_awaited_once_with(RAW,
                                                   mailbox='"Drafts"',
                                                   flags="\\Seen")


@pytest.mark.asyncio
async def test_save_files_a_copy_even_with_save_copy_off(imap, smtp):
    # --save is the user asking on this one line, so the account-level
    # switch does not veto it.
    _, warning = await deliver(config(save_copy=False), RAW, "Drafts")
    assert warning == ""
    imap["client"].append.assert_awaited_once()
