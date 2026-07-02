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

import pytest

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import IndexEntry, RAMIndexCacheStore
from mirage.core.slack.stat import stat
from mirage.resource.slack.config import SlackConfig
from mirage.types import FileType, PathSpec


@pytest.fixture
def config():
    return SlackConfig(token="xoxb-test-token")


@pytest.fixture
def accessor(config):
    return SlackAccessor(config=config)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


async def _populate_index(index: RAMIndexCacheStore) -> None:
    await index.set_dir("/channels", [
        (
            "general__C001",
            IndexEntry(
                id="C001",
                name="general",
                resource_type="slack/channel",
                remote_time="1609459200",
                vfs_name="general__C001",
            ),
        ),
    ])
    await index.set_dir("/users", [
        (
            "alice.json",
            IndexEntry(
                id="U001",
                name="alice",
                resource_type="slack/user",
                vfs_name="alice.json",
            ),
        ),
    ])


@pytest.mark.asyncio
async def test_stat_root(accessor, index):
    result = await stat(accessor,
                        PathSpec(resource_path=("/").strip("/"),
                                 virtual="/",
                                 directory="/"),
                        index=index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_channel(accessor, index):
    await _populate_index(index)
    result = await stat(
        accessor,
        PathSpec(resource_path=("/channels/general__C001").strip("/"),
                 virtual="/channels/general__C001",
                 directory="/channels/general__C001"),
        index=index)
    assert result.type == FileType.DIRECTORY
    assert result.extra["channel_id"] == "C001"
    assert result.modified == "2021-01-01T00:00:00Z"


@pytest.mark.asyncio
async def test_stat_user(accessor, index):
    await _populate_index(index)
    result = await stat(accessor,
                        PathSpec(
                            resource_path=("/users/alice.json").strip("/"),
                            virtual="/users/alice.json",
                            directory="/users/alice.json"),
                        index=index)
    assert result.type == FileType.JSON
    assert result.extra["user_id"] == "U001"


@pytest.mark.asyncio
async def test_stat_jsonl(accessor, index):
    await _populate_index(index)
    result = await stat(
        accessor,
        PathSpec(resource_path=(
            "/channels/general__C001/2023-11-14/chat.jsonl").strip("/"),
                 virtual="/channels/general__C001/2023-11-14/chat.jsonl",
                 directory="/channels/general__C001/2023-11-14/chat.jsonl"),
        index=index)
    assert result.type == FileType.TEXT
    assert result.name == "chat.jsonl"


@pytest.mark.asyncio
async def test_stat_not_found(accessor, index):
    with pytest.raises(FileNotFoundError):
        await stat(accessor,
                   PathSpec(resource_path=("/nonexistent/path").strip("/"),
                            virtual="/nonexistent/path",
                            directory="/nonexistent/path"),
                   index=index)


@pytest.mark.asyncio
async def test_stat_date_dir(accessor, index):
    await index.set_dir("/channels/general__C001", [
        ("2026-04-10",
         IndexEntry(id="C001:2026-04-10",
                    name="2026-04-10",
                    resource_type="slack/date_dir",
                    vfs_name="2026-04-10")),
    ])
    s = await stat(
        accessor,
        PathSpec(
            resource_path=("/channels/general__C001/2026-04-10").strip("/"),
            virtual="/channels/general__C001/2026-04-10",
            directory="/channels/general__C001/2026-04-10"),
        index=index)
    assert s.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_non_date_dir_not_found(accessor, index):
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            PathSpec(
                resource_path=("/channels/general__C001/notadate").strip("/"),
                virtual="/channels/general__C001/notadate",
                directory="/channels/general__C001/notadate"),
            index=index)


@pytest.mark.asyncio
async def test_stat_chat_jsonl(accessor, index):
    s = await stat(
        accessor,
        PathSpec(resource_path=(
            "/channels/general__C001/2026-04-10/chat.jsonl").strip("/"),
                 virtual="/channels/general__C001/2026-04-10/chat.jsonl",
                 directory="/channels/general__C001/2026-04-10/chat.jsonl"),
        index=index)
    assert s.type == FileType.TEXT


@pytest.mark.asyncio
async def test_stat_files_dir(accessor, index):
    s = await stat(
        accessor,
        PathSpec(resource_path=(
            "/channels/general__C001/2026-04-10/files").strip("/"),
                 virtual="/channels/general__C001/2026-04-10/files",
                 directory="/channels/general__C001/2026-04-10/files"),
        index=index)
    assert s.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_file_blob_pdf(accessor, index):
    await index.set_dir("/channels/general__C001/2026-04-10/files", [
        ("report__F1.pdf",
         IndexEntry(id="F1",
                    name="report",
                    resource_type="slack/file",
                    vfs_name="report__F1.pdf",
                    size=4096,
                    extra={
                        "mimetype": "application/pdf",
                        "url_private_download": "u",
                        "channel_id": "C001",
                        "date": "2026-04-10"
                    })),
    ])
    s = await stat(
        accessor,
        PathSpec(
            resource_path=(
                "/channels/general__C001/2026-04-10/files/report__F1.pdf"
            ).strip("/"),
            virtual="/channels/general__C001/2026-04-10/files/report__F1.pdf",
            directory="/channels/general__C001/2026-04-10/files/report__F1.pdf"
        ),
        index=index)
    assert s.type == FileType.PDF
    assert s.size == 4096


@pytest.mark.asyncio
async def test_stat_file_blob_text(accessor, index):
    await index.set_dir("/channels/general__C001/2026-04-10/files", [
        ("notes__F2.txt",
         IndexEntry(id="F2",
                    name="notes",
                    resource_type="slack/file",
                    vfs_name="notes__F2.txt",
                    size=128,
                    extra={
                        "mimetype": "text/plain",
                        "url_private_download": "u",
                        "channel_id": "C001",
                        "date": "2026-04-10"
                    })),
    ])
    s = await stat(
        accessor,
        PathSpec(
            resource_path=(
                "/channels/general__C001/2026-04-10/files/notes__F2.txt"
            ).strip("/"),
            virtual="/channels/general__C001/2026-04-10/files/notes__F2.txt",
            directory="/channels/general__C001/2026-04-10/files/notes__F2.txt"
        ),
        index=index)
    assert s.type == FileType.TEXT


@pytest.mark.asyncio
async def test_stat_file_blob_unknown_mimetype_is_binary(accessor, index):
    await index.set_dir("/channels/general__C001/2026-04-10/files", [
        ("data__F3.bin",
         IndexEntry(id="F3",
                    name="data",
                    resource_type="slack/file",
                    vfs_name="data__F3.bin",
                    size=2048,
                    extra={
                        "mimetype": "application/octet-stream",
                        "url_private_download": "u",
                        "channel_id": "C001",
                        "date": "2026-04-10"
                    })),
    ])
    s = await stat(
        accessor,
        PathSpec(
            resource_path=(
                "/channels/general__C001/2026-04-10/files/data__F3.bin"
            ).strip("/"),
            virtual="/channels/general__C001/2026-04-10/files/data__F3.bin",
            directory="/channels/general__C001/2026-04-10/files/data__F3.bin"),
        index=index)
    assert s.type == FileType.BINARY
    assert s.size == 2048
