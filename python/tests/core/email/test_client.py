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
from mirage.core.email._client import list_folders, list_message_uids
from mirage.core.email.config import EmailConfig


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
