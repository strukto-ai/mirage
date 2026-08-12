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

from unittest.mock import AsyncMock, MagicMock

import pytest

from mirage.accessor.email import EmailAccessor
from mirage.core.email._client import (fetch_headers, fetch_message,
                                       list_folder_entries, list_folders,
                                       list_message_uids, parse_folder_line,
                                       quote_mailbox, select_folder)
from mirage.core.email.config import EmailConfig

MESSAGE = (b"From: alice@example.com\r\n"
           b"To: bob@example.com\r\n"
           b"Subject: Hello\r\n"
           b"MIME-Version: 1.0\r\n"
           b"Content-Type: text/plain; charset=utf-8\r\n"
           b"\r\n"
           b"a message with no Date header at all\r\n")

FETCH_LINE = (b'1 FETCH (FLAGS () INTERNALDATE "07-Aug-2026 20:54:05 +0000" '
              b"UID 101 BODY[] {%d}" % len(MESSAGE))


@pytest.fixture
def config():
    return EmailConfig(
        imap_host="imap.test.com",
        smtp_host="smtp.test.com",
        username="user@test.com",
        password="pass",
    )


@pytest.fixture
def accessor(config):
    return EmailAccessor(config)


@pytest.mark.asyncio
async def test_list_folders(accessor):
    mock_imap = AsyncMock()
    mock_response = MagicMock()
    mock_response.lines = [
        b'(\\HasNoChildren) "/" "INBOX"',
        b'(\\HasNoChildren) "/" "Sent"',
        b'(\\HasNoChildren) "/" "Drafts"',
    ]
    mock_imap.list.return_value = mock_response
    accessor._imap = mock_imap
    accessor._imap.protocol = True

    folders = await list_folders(accessor)
    assert "INBOX" in folders
    assert "Sent" in folders
    assert "Drafts" in folders


@pytest.mark.asyncio
async def test_list_folder_entries_reports_special_use_attributes(accessor):
    mock_imap = AsyncMock()
    mock_response = MagicMock()
    mock_response.lines = [
        b'(\\HasNoChildren) "/" "INBOX"',
        b'(\\HasNoChildren \\Sent) "/" "[Gmail]/Sent Mail"',
        b"LIST completed",
    ]
    mock_imap.list.return_value = mock_response
    accessor._imap = mock_imap
    accessor._imap.protocol = True

    entries = await list_folder_entries(accessor)
    assert entries == [
        ("INBOX", ("\\HasNoChildren", )),
        ("[Gmail]/Sent Mail", ("\\HasNoChildren", "\\Sent")),
    ]


def test_parse_folder_line_skips_the_completion_line():
    assert parse_folder_line(b"LIST completed") is None


def test_parse_folder_line_reads_a_name_holding_a_paren():
    assert parse_folder_line(b'(\\HasNoChildren) "/" "Notes (old)"') == (
        "Notes (old)", ("\\HasNoChildren", ))


def test_quote_mailbox_wraps_and_escapes():
    assert quote_mailbox("Sent Items") == '"Sent Items"'
    assert quote_mailbox('od"d') == '"od\\"d"'
    assert quote_mailbox("back\\slash") == '"back\\\\slash"'


@pytest.mark.asyncio
async def test_select_quotes_a_mailbox_holding_a_space():
    mock_imap = AsyncMock()
    selected = MagicMock()
    selected.result = "OK"
    mock_imap.select.return_value = selected

    await select_folder(mock_imap, "[Gmail]/Sent Mail")
    mock_imap.select.assert_awaited_once_with('"[Gmail]/Sent Mail"')


@pytest.mark.asyncio
async def test_list_message_uids(accessor):
    mock_imap = AsyncMock()
    mock_select_response = MagicMock()
    mock_select_response.result = "OK"
    mock_imap.select.return_value = mock_select_response

    mock_search_response = MagicMock()
    mock_search_response.result = "OK"
    mock_search_response.lines = [b"1 2 3 4 5"]
    mock_imap.search.return_value = mock_search_response

    mock_fetch_response = MagicMock()
    mock_fetch_response.lines = [
        b"1 FETCH (UID 101)",
        b"2 FETCH (UID 102)",
        b"3 FETCH (UID 103)",
        b"4 FETCH (UID 104)",
        b"5 FETCH (UID 105)",
        b"FETCH completed",
    ]
    mock_imap.fetch.return_value = mock_fetch_response
    accessor._imap = mock_imap
    accessor._imap.protocol = True

    uids = await list_message_uids(accessor, "INBOX")
    assert uids == ["101", "102", "103", "104", "105"]


@pytest.mark.asyncio
async def test_list_message_uids_empty(accessor):
    mock_imap = AsyncMock()
    mock_select_response = MagicMock()
    mock_select_response.result = "OK"
    mock_imap.select.return_value = mock_select_response

    mock_search_response = MagicMock()
    mock_search_response.result = "OK"
    mock_search_response.lines = [b""]
    mock_imap.search.return_value = mock_search_response
    accessor._imap = mock_imap
    accessor._imap.protocol = True

    uids = await list_message_uids(accessor, "INBOX")
    assert uids == []


@pytest.mark.asyncio
async def test_a_missing_mailbox_names_itself(accessor):
    mock_imap = AsyncMock()
    mock_select_response = MagicMock()
    mock_select_response.result = "NO"
    mock_imap.select.return_value = mock_select_response
    accessor._imap = mock_imap
    accessor._imap.protocol = True

    # An unchecked SELECT leaves the session in AUTH state and the next
    # command complains about that instead of the mailbox.
    with pytest.raises(FileNotFoundError, match="no such mailbox 'Nope'"):
        await list_message_uids(accessor, "Nope")
    mock_imap.search.assert_not_called()


@pytest.mark.asyncio
async def test_a_refused_search_is_not_an_empty_result(accessor):
    mock_imap = AsyncMock()
    mock_select_response = MagicMock()
    mock_select_response.result = "OK"
    mock_imap.select.return_value = mock_select_response

    mock_search_response = MagicMock()
    mock_search_response.result = "BAD"
    mock_search_response.lines = [b""]
    mock_imap.search.return_value = mock_search_response
    accessor._imap = mock_imap
    accessor._imap.protocol = True

    with pytest.raises(ValueError, match="IMAP rejected the search"):
        await list_message_uids(accessor, "INBOX", "SENTON not-a-date")


def _fetch_imap() -> AsyncMock:
    mock_imap = AsyncMock()
    mock_select_response = MagicMock()
    mock_select_response.result = "OK"
    mock_imap.select.return_value = mock_select_response

    mock_fetch_response = MagicMock()
    mock_fetch_response.lines = [
        FETCH_LINE,
        bytearray(MESSAGE),
        b")",
        b"FETCH completed.",
    ]
    mock_imap.uid.return_value = mock_fetch_response
    return mock_imap


@pytest.mark.asyncio
async def test_fetch_headers_reads_internaldate(accessor):
    accessor._imap = _fetch_imap()
    accessor._imap.protocol = True

    headers = await fetch_headers(accessor, "INBOX", ["101"])

    assert len(headers) == 1
    assert headers[0]["date"] == ""
    assert headers[0]["internal_date"] == "07-Aug-2026 20:54:05 +0000"
    assert headers[0]["uid"] == "101"


@pytest.mark.asyncio
async def test_fetch_message_reads_internaldate(accessor):
    accessor._imap = _fetch_imap()
    accessor._imap.protocol = True

    msg = await fetch_message(accessor, "INBOX", "101")

    assert msg["internal_date"] == "07-Aug-2026 20:54:05 +0000"


@pytest.mark.asyncio
async def test_a_message_quoting_internaldate_is_not_read_as_one(accessor):
    quoted = b'the header reads INTERNALDATE "01-Jan-1990 00:00:00 +0000"\r\n'
    body = MESSAGE + quoted
    mock_imap = AsyncMock()
    mock_select_response = MagicMock()
    mock_select_response.result = "OK"
    mock_imap.select.return_value = mock_select_response
    mock_fetch_response = MagicMock()
    # No INTERNALDATE on the descriptor line, and the message text quotes
    # one: the literal payload must not answer for the mailbox.
    mock_fetch_response.lines = [
        b"1 FETCH (FLAGS () UID 101 BODY[] {%d}" % len(body),
        bytearray(body),
        b")",
    ]
    mock_imap.uid.return_value = mock_fetch_response
    accessor._imap = mock_imap
    accessor._imap.protocol = True

    msg = await fetch_message(accessor, "INBOX", "101")

    assert msg["internal_date"] == ""


@pytest.mark.asyncio
async def test_fetch_asks_for_metadata_before_the_body(accessor):
    # A server may answer the items in the order they were requested, and
    # anything after BODY[] lands on the line behind the literal, where
    # neither response parser looks.
    accessor._imap = _fetch_imap()
    accessor._imap.protocol = True

    await fetch_message(accessor, "INBOX", "101")

    items = accessor._imap.uid.call_args[0][-1]
    assert items.index("INTERNALDATE") < items.index("BODY.PEEK[]")
    assert items.index("FLAGS") < items.index("BODY.PEEK[]")
    assert items.index("UID") < items.index("BODY.PEEK[]")
