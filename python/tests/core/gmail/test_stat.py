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

from mirage.accessor.gmail import GmailAccessor
from mirage.cache.index import IndexEntry, RAMIndexCacheStore
from mirage.core.gmail.stat import stat
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def accessor():
    return GmailAccessor(config=None, token_manager=None)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


async def _populate_index(idx):
    await idx.set_dir("/gmail", [
        ("INBOX",
         IndexEntry(
             id="INBOX",
             name="INBOX",
             resource_type="gmail/label",
             vfs_name="INBOX",
         )),
    ])
    await idx.set_dir("/gmail/INBOX", [
        ("2026-04-12",
         IndexEntry(
             id="2026-04-12",
             name="2026-04-12",
             resource_type="gmail/date",
             vfs_name="2026-04-12",
         )),
    ])
    await idx.set_dir("/gmail/INBOX/2026-04-12", [
        ("Test_Email__msg1.gmail.json",
         IndexEntry(
             id="msg1",
             name="Test Email",
             resource_type="gmail/message",
             vfs_name="Test_Email__msg1.gmail.json",
         )),
        ("Test_Email__msg1",
         IndexEntry(
             id="msg1",
             name="Test_Email__msg1",
             resource_type="gmail/attachment_dir",
             vfs_name="Test_Email__msg1",
         )),
    ])
    await idx.set_dir("/gmail/INBOX/2026-04-12/Test_Email__msg1", [
        ("image.png",
         IndexEntry(
             id="att1",
             name="image.png",
             resource_type="gmail/attachment",
             vfs_name="image.png",
             size=2048,
         )),
    ])


@pytest.mark.asyncio
async def test_stat_root(accessor, index):
    result = await stat(
        accessor,
        PathSpec(resource_path=mount_key("/", "/gmail"),
                 virtual="/",
                 directory="/"), index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_label(accessor, index):
    await _populate_index(index)
    result = await stat(
        accessor,
        PathSpec(resource_path=mount_key("/gmail/INBOX", "/gmail"),
                 virtual="/gmail/INBOX",
                 directory="/gmail/INBOX"), index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "INBOX"
    assert result.extra["label_id"] == "INBOX"


@pytest.mark.asyncio
async def test_stat_date(accessor, index):
    await _populate_index(index)
    result = await stat(
        accessor,
        PathSpec(resource_path=mount_key("/gmail/INBOX/2026-04-12", "/gmail"),
                 virtual="/gmail/INBOX/2026-04-12",
                 directory="/gmail/INBOX/2026-04-12"), index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "2026-04-12"


@pytest.mark.asyncio
async def test_stat_message(accessor, index):
    await _populate_index(index)
    result = await stat(
        accessor,
        PathSpec(
            resource_path=mount_key(
                "/gmail/INBOX/2026-04-12/Test_Email__msg1.gmail.json",
                "/gmail"),
            virtual="/gmail/INBOX/2026-04-12/Test_Email__msg1.gmail.json",
            directory="/gmail/INBOX/2026-04-12/Test_Email__msg1.gmail.json"),
        index,
    )
    assert result.name == "Test_Email__msg1.gmail.json"
    assert result.type == FileType.JSON
    assert result.extra["message_id"] == "msg1"


@pytest.mark.asyncio
async def test_stat_attachment(accessor, index):
    await _populate_index(index)
    result = await stat(
        accessor,
        PathSpec(
            resource_path=mount_key(
                "/gmail/INBOX/2026-04-12/Test_Email__msg1/image.png",
                "/gmail"),
            virtual="/gmail/INBOX/2026-04-12/Test_Email__msg1/image.png",
            directory="/gmail/INBOX/2026-04-12/Test_Email__msg1/image.png"),
        index,
    )
    assert result.name == "image.png"
    assert result.size == 2048
    assert result.extra["attachment_id"] == "att1"


@pytest.mark.asyncio
async def test_stat_not_found(accessor, index):
    await _populate_index(index)
    with patch(
            "mirage.core.gmail.readdir.list_labels",
            new_callable=AsyncMock,
            return_value=[],
    ):
        with patch(
                "mirage.core.gmail.readdir.list_messages",
                new_callable=AsyncMock,
                return_value=([], None),
        ):
            with pytest.raises(FileNotFoundError):
                await stat(
                    accessor,
                    PathSpec(resource_path=mount_key(
                        "/gmail/INBOX/nonexistent.gmail.json", "/gmail"),
                             virtual="/gmail/INBOX/nonexistent.gmail.json",
                             directory="/gmail/INBOX/nonexistent.gmail.json"),
                    index,
                )


@pytest.mark.asyncio
async def test_stat_unknown_top_level_raises(accessor, index):
    with patch(
            "mirage.core.gmail.stat.list_labels",
            new_callable=AsyncMock,
            return_value=[{
                "type": "system",
                "id": "INBOX"
            }],
    ):
        with pytest.raises(FileNotFoundError):
            await stat(
                accessor,
                PathSpec(resource_path=mount_key("/gmail/NoSuchLabel",
                                                 "/gmail"),
                         virtual="/gmail/NoSuchLabel",
                         directory="/gmail/NoSuchLabel"), index)


@pytest.mark.asyncio
async def test_stat_real_label_via_api(accessor, index):
    with patch(
            "mirage.core.gmail.stat.list_labels",
            new_callable=AsyncMock,
            return_value=[{
                "type": "system",
                "id": "STARRED"
            }],
    ):
        result = await stat(
            accessor,
            PathSpec(resource_path=mount_key("/gmail/STARRED", "/gmail"),
                     virtual="/gmail/STARRED",
                     directory="/gmail/STARRED"), index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "STARRED"


@pytest.mark.asyncio
async def test_stat_index_none_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            PathSpec(resource_path=mount_key("/gmail/INBOX/x.gmail.json",
                                             "/gmail"),
                     virtual="/gmail/INBOX/x.gmail.json",
                     directory="/gmail/INBOX/x.gmail.json"), None)
