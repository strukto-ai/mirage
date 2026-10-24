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

from contextlib import contextmanager
from unittest.mock import AsyncMock

import pytest

from mirage.accessor.gmail import GmailAccessor
from mirage.core.gmail.messages import message_json_bytes
from mirage.core.gmail.stat import stat
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gmail import GmailVFS
from mirage.vfs.gmail.config import GmailConfig
from tests.fixtures.gmail_api import StubGmail
from tests.fixtures.google_api import offline_token_manager, serve
from tests.fixtures.mounted import Mounted


@pytest.fixture
def accessor():
    return GmailAccessor(
        config=GmailConfig(access_token="t"),
        token_manager=offline_token_manager(),
    )


RAW = {
    "id": "msg1",
    "internalDate": "1775995200000",
    "sizeEstimate": 4321,
    "payload": {
        "headers": [{"name": "Subject", "value": "Test Email"}],
        "parts": [
            {
                "filename": "image.png",
                "mimeType": "image/png",
                "body": {"attachmentId": "att1", "size": 2048},
            }
        ],
    },
}


@contextmanager
def _mailbox():
    """One label holding one message, on 2026-04-12, with an attachment."""
    with (
        serve(
            gmail=StubGmail(
                list_labels=AsyncMock(
                    return_value=[{"type": "system", "id": "INBOX"}]
                ),
                list_messages=AsyncMock(return_value=[{"id": "msg1"}]),
                get_message_raw=AsyncMock(return_value=RAW),
            )
        ),
    ):
        yield


async def _stat_at(accessor: GmailAccessor, path: str) -> FileStat:
    return await Mounted(GmailVFS, accessor, "/gmail").stat(path)


@pytest.mark.asyncio
async def test_stat_root(accessor):
    result = await stat(
        accessor,
        PathSpec(
            vfs_path=mount_key("/", "/gmail"), virtual="/", directory="/"
        ),
    )
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_label(accessor):
    with _mailbox():
        result = await _stat_at(accessor, "/INBOX")
    assert result.type == FileType.DIRECTORY
    assert result.name == "INBOX"
    assert result.extra["label_id"] == "INBOX"


@pytest.mark.asyncio
async def test_stat_date(accessor):
    with _mailbox():
        result = await _stat_at(accessor, "/INBOX/2026-04-12")
    assert result.type == FileType.DIRECTORY
    assert result.name == "2026-04-12"


@pytest.mark.asyncio
async def test_stat_date_outside_the_listed_window(accessor):
    # The label listing is a bounded window of recent messages, so it never
    # minted this day; the date query answers for any well-formed one, so the
    # label's existence is the proof rather than the window.
    with _mailbox():
        result = await _stat_at(accessor, "/INBOX/2020-01-01")
    assert result.type == FileType.DIRECTORY
    assert result.name == "2020-01-01"


@pytest.mark.asyncio
async def test_stat_message(accessor):
    with _mailbox():
        result = await _stat_at(
            accessor, "/INBOX/2026-04-12/Test_Email__msg1.gmail.json"
        )
    assert result.name == "Test_Email__msg1.gmail.json"
    assert result.content == ContentType.JSON
    assert result.extra["message_id"] == "msg1"
    # the listing fetched the message, so the size is the rendered
    # .gmail.json length; the source estimate is surfaced via extra only
    assert result.size == len(message_json_bytes(RAW))
    assert result.extra["size_estimate"] == 4321


@pytest.mark.asyncio
async def test_stat_attachment(accessor):
    with _mailbox():
        result = await _stat_at(
            accessor, "/INBOX/2026-04-12/Test_Email__msg1/image.png"
        )
    assert result.name == "image.png"
    assert result.size == 2048
    assert result.extra["attachment_id"] == "att1"


@pytest.mark.asyncio
async def test_stat_not_found(accessor):
    with serve(gmail=StubGmail(list_labels=AsyncMock(return_value=[]))):
        with pytest.raises(FileNotFoundError):
            await _stat_at(accessor, "/INBOX/nonexistent.gmail.json")


@pytest.mark.asyncio
async def test_stat_unknown_top_level_raises(accessor):
    with serve(
        gmail=StubGmail(
            list_labels=AsyncMock(
                return_value=[{"type": "system", "id": "INBOX"}]
            )
        )
    ):
        with pytest.raises(FileNotFoundError):
            await _stat_at(accessor, "/NoSuchLabel")


@pytest.mark.asyncio
async def test_stat_real_label_via_api(accessor):
    with serve(
        gmail=StubGmail(
            list_labels=AsyncMock(
                return_value=[{"type": "system", "id": "STARRED"}]
            )
        )
    ):
        result = await _stat_at(accessor, "/STARRED")
    assert result.type == FileType.DIRECTORY
    assert result.name == "STARRED"


@pytest.mark.asyncio
async def test_stat_propagates_parent_refresh_failure(accessor):
    failure = RuntimeError("gmail unavailable")
    with serve(gmail=StubGmail(list_labels=AsyncMock(side_effect=failure))):
        with pytest.raises(RuntimeError, match="gmail unavailable"):
            await _stat_at(
                accessor, "/INBOX/2026-04-12/missing__x1.gmail.json"
            )
