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
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.gmail import GmailAccessor
from mirage.cache.index import IndexEntry, RAMIndexCacheStore
from mirage.core.gmail.read import read
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def accessor():
    return GmailAccessor(config=None, token_manager=None)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_read_message(accessor, index):
    await index.set_dir("/gmail/INBOX/2026-04-12", [
        ("Test_Email__msg1.gmail.json",
         IndexEntry(
             id="msg1",
             name="Test Email",
             resource_type="gmail/message",
             vfs_name="Test_Email__msg1.gmail.json",
         )),
    ])
    processed = {"id": "msg1", "subject": "Test Email", "body_text": "Hello!"}
    with patch(
            "mirage.core.gmail.read.get_message_processed",
            new_callable=AsyncMock,
            return_value=processed,
    ):
        result = await read(
            accessor,
            PathSpec(
                resource_path=mount_key(
                    "/gmail/INBOX/2026-04-12"
                    "/Test_Email__msg1.gmail.json", "/gmail"),
                virtual="/gmail/INBOX/2026-04-12"
                "/Test_Email__msg1.gmail.json",
                directory="/gmail/INBOX/2026-04-12"
                "/Test_Email__msg1.gmail.json",
            ),
            index,
        )
        parsed = json.loads(result)
        assert parsed["id"] == "msg1"
        assert parsed["subject"] == "Test Email"


@pytest.mark.asyncio
async def test_read_not_found(accessor, index):
    with pytest.raises(FileNotFoundError):
        await read(
            accessor,
            PathSpec(resource_path=mount_key(
                "/gmail/INBOX/nonexistent.gmail.json", "/gmail"),
                     virtual="/gmail/INBOX/nonexistent.gmail.json",
                     directory="/gmail/INBOX/nonexistent.gmail.json"),
            index,
        )


@pytest.mark.asyncio
async def test_read_is_directory(accessor, index):
    await index.set_dir("/gmail", [
        ("INBOX",
         IndexEntry(
             id="INBOX",
             name="INBOX",
             resource_type="gmail/label",
             vfs_name="INBOX",
         )),
    ])
    with pytest.raises(IsADirectoryError):
        await read(
            accessor,
            PathSpec(resource_path=mount_key("/gmail/INBOX", "/gmail"),
                     virtual="/gmail/INBOX",
                     directory="/gmail/INBOX"),
            index,
        )


@pytest.mark.asyncio
async def test_read_auto_bootstraps_from_empty_index(accessor, index):
    raw_msg = {
        "id": "msg-1",
        "threadId": "t-1",
        "internalDate": str(1777248000000),
        "sizeEstimate": 1024,
        "labelIds": ["INBOX"],
        "snippet": "hello",
        "payload": {
            "headers": [{
                "name": "Subject",
                "value": "Hello World"
            }],
        },
    }
    processed = {"id": "msg-1", "subject": "Hello World", "body_text": "hi"}
    with (
            patch(
                "mirage.core.gmail.readdir.list_labels",
                new_callable=AsyncMock,
                return_value=[{
                    "id": "INBOX",
                    "name": "INBOX",
                    "type": "system"
                }],
            ),
            patch(
                "mirage.core.gmail.readdir.list_messages",
                new_callable=AsyncMock,
                return_value=[{
                    "id": "msg-1",
                    "threadId": "t-1"
                }],
            ),
            patch(
                "mirage.core.gmail.readdir.get_message_raw",
                new_callable=AsyncMock,
                return_value=raw_msg,
            ),
            patch(
                "mirage.core.gmail.read.get_message_processed",
                new_callable=AsyncMock,
                return_value=processed,
            ),
    ):
        result = await read(
            accessor,
            PathSpec(
                resource_path=mount_key(
                    "/gmail/INBOX/2026-04-27"
                    "/Hello_World__msg-1.gmail.json", "/gmail"),
                virtual="/gmail/INBOX/2026-04-27"
                "/Hello_World__msg-1.gmail.json",
                directory="/gmail/INBOX/2026-04-27"
                "/Hello_World__msg-1.gmail.json",
            ),
            index,
        )
        parsed = json.loads(result)
        assert parsed["subject"] == "Hello World"


@pytest.mark.asyncio
async def test_read_attachment(accessor, index):
    await index.set_dir("/gmail/INBOX/2026-04-12", [
        ("Meeting__msg1.gmail.json",
         IndexEntry(
             id="msg1",
             name="Meeting",
             resource_type="gmail/message",
             vfs_name="Meeting__msg1.gmail.json",
         )),
        ("Meeting__msg1",
         IndexEntry(
             id="msg1",
             name="Meeting__msg1",
             resource_type="gmail/attachment_dir",
             vfs_name="Meeting__msg1",
         )),
    ])
    await index.set_dir(
        "/gmail/INBOX/2026-04-12/Meeting__msg1",
        [
            ("report.pdf",
             IndexEntry(
                 id="att1",
                 name="report.pdf",
                 resource_type="gmail/attachment",
                 vfs_name="report.pdf",
                 size=1024,
             )),
        ],
    )
    with patch(
            "mirage.core.gmail.read.get_attachment",
            new_callable=AsyncMock,
            return_value=b"pdf-bytes",
    ):
        result = await read(
            accessor,
            PathSpec(
                resource_path=mount_key(
                    "/gmail/INBOX/2026-04-12/Meeting__msg1/report.pdf",
                    "/gmail"),
                virtual="/gmail/INBOX/2026-04-12/Meeting__msg1/report.pdf",
                directory="/gmail/INBOX/2026-04-12/Meeting__msg1/report.pdf",
            ),
            index,
        )
        assert result == b"pdf-bytes"
