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
from unittest.mock import AsyncMock

import pytest

from mirage.accessor.gmail import GmailAccessor
from mirage.core.gmail.read import read
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gmail import GmailVFS
from mirage.vfs.gmail.config import GmailConfig
from tests.fixtures.gmail_api import StubGmail
from tests.fixtures.google_api import serve
from tests.fixtures.mounted import Mounted


@pytest.fixture
def accessor():
    return GmailAccessor(
        config=GmailConfig(access_token="t"), token_manager=None
    )


def _row(name: str, **extra: str) -> FileStat:
    """A file's row as its folder's listing names it."""
    return FileStat(name=name, type=FileType.FILE, extra=extra)


@pytest.mark.asyncio
async def test_read_message(accessor):
    raw_msg = {
        "id": "msg1",
        "threadId": "t1",
        "snippet": "Hello!",
        "payload": {
            "headers": [{"name": "Subject", "value": "Test Email"}],
        },
    }
    with serve(
        gmail=StubGmail(get_message_raw=AsyncMock(return_value=raw_msg))
    ):
        result = await read(
            accessor,
            PathSpec(
                vfs_path=mount_key(
                    "/gmail/INBOX/2026-04-12/Test_Email__msg1.gmail.json",
                    "/gmail",
                ),
                virtual="/gmail/INBOX/2026-04-12/Test_Email__msg1.gmail.json",
                directory="/gmail/INBOX/2026-04-12"
                "/Test_Email__msg1.gmail.json",
            ),
            _row("Test_Email__msg1.gmail.json", message_id="msg1"),
        )
        parsed = json.loads(result)
        assert parsed["id"] == "msg1"
        assert parsed["subject"] == "Test Email"


@pytest.mark.asyncio
async def test_read_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await read(
            accessor,
            PathSpec(
                vfs_path=mount_key(
                    "/gmail/INBOX/nonexistent.gmail.json", "/gmail"
                ),
                virtual="/gmail/INBOX/nonexistent.gmail.json",
                directory="/gmail/INBOX/nonexistent.gmail.json",
            ),
        )


@pytest.mark.asyncio
async def test_read_is_directory(accessor):
    # A directory kind has no reader, and a matched shape alone is no
    # existence proof, so the kit answers "No such file" (the same rule
    # gcal, notion and the database mounts pin).
    with pytest.raises(FileNotFoundError):
        await read(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gmail/INBOX", "/gmail"),
                virtual="/gmail/INBOX",
                directory="/gmail/INBOX",
            ),
        )


@pytest.mark.asyncio
async def test_a_cold_read_lists_its_way_to_the_message(accessor):
    raw_msg = {
        "id": "msg-1",
        "threadId": "t-1",
        "internalDate": str(1777248000000),
        "sizeEstimate": 1024,
        "labelIds": ["INBOX"],
        "snippet": "hello",
        "payload": {
            "headers": [{"name": "Subject", "value": "Hello World"}],
        },
    }
    with (
        serve(
            gmail=StubGmail(
                list_labels=AsyncMock(
                    return_value=[
                        {"id": "INBOX", "name": "INBOX", "type": "system"}
                    ]
                ),
                list_messages=AsyncMock(
                    return_value=[{"id": "msg-1", "threadId": "t-1"}]
                ),
                get_message_raw=AsyncMock(return_value=raw_msg),
            )
        ),
    ):
        result = await Mounted(GmailVFS, accessor, "/gmail").read(
            "/INBOX/2026-04-27/Hello_World__msg-1.gmail.json"
        )
        parsed = json.loads(result)
        assert parsed["subject"] == "Hello World"


@pytest.mark.asyncio
async def test_read_attachment(accessor):
    with serve(
        gmail=StubGmail(get_attachment=AsyncMock(return_value=b"pdf-bytes"))
    ):
        result = await read(
            accessor,
            PathSpec(
                vfs_path=mount_key(
                    "/gmail/INBOX/2026-04-12/Meeting__msg1/report.pdf",
                    "/gmail",
                ),
                virtual="/gmail/INBOX/2026-04-12/Meeting__msg1/report.pdf",
                directory="/gmail/INBOX/2026-04-12/Meeting__msg1/report.pdf",
            ),
            _row("report.pdf", attachment_id="att1"),
        )
        assert result == b"pdf-bytes"
