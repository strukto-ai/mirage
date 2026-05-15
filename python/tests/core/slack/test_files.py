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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import IndexEntry, RAMIndexCacheStore
from mirage.core.slack.readdir import readdir
from mirage.resource.slack.config import SlackConfig
from mirage.types import PathSpec


@pytest.fixture
def config():
    return SlackConfig(token="xoxb-test")


@pytest.fixture
def accessor(config):
    return SlackAccessor(config=config)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.fixture
def messages_with_files():
    return [
        {
            "type":
            "message",
            "user":
            "U1",
            "ts":
            "1712707200.0",
            "text":
            "here's the report",
            "files": [{
                "id":
                "F1ABC",
                "name":
                "report.pdf",
                "title":
                "report.pdf",
                "filetype":
                "pdf",
                "mimetype":
                "application/pdf",
                "size":
                4096,
                "url_private_download": ("https://files.slack.com/files-pri"
                                         "/T1-F1ABC/download/report.pdf"),
                "timestamp":
                1712707200,
            }],
        },
        {
            "type": "message",
            "user": "U2",
            "ts": "1712707260.0",
            "text": "no file here",
        },
    ]


@pytest.mark.asyncio
async def test_files_dir_listing_from_messages(accessor, index,
                                               messages_with_files):
    await index.set_dir("/channels", [
        ("general__C001",
         IndexEntry(id="C001",
                    name="general",
                    resource_type="slack/channel",
                    vfs_name="general__C001",
                    remote_time="1700000000")),
    ])
    await index.set_dir("/channels/general__C001", [
        ("2026-04-10",
         IndexEntry(id="C001:2026-04-10",
                    name="2026-04-10",
                    resource_type="slack/date_dir",
                    vfs_name="2026-04-10")),
    ])
    with patch("mirage.core.slack.readdir.fetch_messages_for_day",
               new_callable=AsyncMock,
               return_value=messages_with_files):
        result = await readdir(
            accessor,
            PathSpec(original="/channels/general__C001/2026-04-10/files",
                     directory="/channels/general__C001/2026-04-10/files"),
            index=index,
        )
    assert result == [
        "/channels/general__C001/2026-04-10/files/report__F1ABC.pdf"
    ]


@pytest.mark.asyncio
async def test_files_dir_empty_on_no_attachments(accessor, index):
    await index.set_dir("/channels", [
        ("general__C001",
         IndexEntry(id="C001",
                    name="general",
                    resource_type="slack/channel",
                    vfs_name="general__C001",
                    remote_time="1700000000")),
    ])
    await index.set_dir("/channels/general__C001", [
        ("2026-04-10",
         IndexEntry(id="C001:2026-04-10",
                    name="2026-04-10",
                    resource_type="slack/date_dir",
                    vfs_name="2026-04-10")),
    ])
    no_file_msgs = [{
        "type": "message",
        "user": "U1",
        "ts": "1712707200.0",
        "text": "hi"
    }]
    with patch("mirage.core.slack.readdir.fetch_messages_for_day",
               new_callable=AsyncMock,
               return_value=no_file_msgs):
        result = await readdir(
            accessor,
            PathSpec(original="/channels/general__C001/2026-04-10/files",
                     directory="/channels/general__C001/2026-04-10/files"),
            index=index,
        )
    assert result == []


@pytest.mark.asyncio
async def test_file_blob_index_entry_stores_url(accessor, index,
                                                messages_with_files):
    await index.set_dir("/channels", [
        ("general__C001",
         IndexEntry(id="C001",
                    name="general",
                    resource_type="slack/channel",
                    vfs_name="general__C001",
                    remote_time="1700000000")),
    ])
    await index.set_dir("/channels/general__C001", [
        ("2026-04-10",
         IndexEntry(id="C001:2026-04-10",
                    name="2026-04-10",
                    resource_type="slack/date_dir",
                    vfs_name="2026-04-10")),
    ])
    with patch("mirage.core.slack.readdir.fetch_messages_for_day",
               new_callable=AsyncMock,
               return_value=messages_with_files):
        await readdir(
            accessor,
            PathSpec(original="/channels/general__C001/2026-04-10/files",
                     directory="/channels/general__C001/2026-04-10/files"),
            index=index,
        )
    blob = await index.get(
        "/channels/general__C001/2026-04-10/files/report__F1ABC.pdf")
    assert blob.entry is not None
    assert blob.entry.id == "F1ABC"
    assert blob.entry.size == 4096
    assert blob.entry.extra["mimetype"] == "application/pdf"
    assert "url_private_download" in blob.entry.extra
    assert blob.entry.extra["filetype"] == "pdf"
    assert blob.entry.extra["ts"] == "1712707200.0"
