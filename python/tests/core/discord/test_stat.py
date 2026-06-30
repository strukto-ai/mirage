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

import asyncio

import pytest

from mirage.accessor.discord import DiscordAccessor
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.discord.stat import stat
from mirage.types import FileType, PathSpec


@pytest.fixture
def index():
    store = RAMIndexCacheStore()
    asyncio.run(
        store.put(
            "/My Server",
            IndexEntry(
                id="G001",
                name="My Server",
                resource_type="discord/guild",
                vfs_name="My Server",
            ),
        ))
    asyncio.run(
        store.put(
            "/My Server/channels/general",
            IndexEntry(
                id="C001",
                name="general",
                resource_type="discord/channel",
                remote_time="794354201395200000",
                vfs_name="general",
            ),
        ))
    asyncio.run(
        store.put(
            "/My Server/members/alice.json",
            IndexEntry(
                id="U001",
                name="alice",
                resource_type="discord/member",
                vfs_name="alice.json",
            ),
        ))
    return store


@pytest.fixture
def accessor():
    return DiscordAccessor(config=object())


@pytest.mark.asyncio
async def test_stat_root(accessor, index):
    result = await stat(accessor, PathSpec(original="/", directory="/"), index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_guild(accessor, index):
    result = await stat(
        accessor, PathSpec(original="/My Server", directory="/My Server"),
        index)
    assert result.type == FileType.DIRECTORY
    assert result.extra["guild_id"] == "G001"


@pytest.mark.asyncio
async def test_stat_channel(accessor, index):
    result = await stat(
        accessor,
        PathSpec(original="/My Server/channels/general",
                 directory="/My Server/channels/general"), index)
    assert result.type == FileType.DIRECTORY
    assert result.extra["channel_id"] == "C001"
    assert result.modified == "2021-01-01T00:00:00Z"


@pytest.mark.asyncio
async def test_stat_member(accessor, index):
    result = await stat(
        accessor,
        PathSpec(original="/My Server/members/alice.json",
                 directory="/My Server/members/alice.json"), index)
    assert result.type == FileType.JSON
    assert result.extra["user_id"] == "U001"


@pytest.mark.asyncio
async def test_stat_date_dir(accessor, index):
    path = "/My Server/channels/general/2024-01-15"
    result = await stat(accessor, PathSpec(original=path, directory=path),
                        index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "2024-01-15"


@pytest.mark.asyncio
async def test_stat_chat_jsonl(accessor, index):
    path = "/My Server/channels/general/2024-01-15/chat.jsonl"
    result = await stat(accessor, PathSpec(original=path, directory=path),
                        index)
    assert result.type == FileType.TEXT
    assert result.name == "chat.jsonl"


@pytest.mark.asyncio
async def test_stat_files_dir(accessor, index):
    path = "/My Server/channels/general/2024-01-15/files"
    result = await stat(accessor, PathSpec(original=path, directory=path),
                        index)
    assert result.type == FileType.DIRECTORY
    assert result.name == "files"


@pytest.mark.asyncio
async def test_stat_non_date_chat_jsonl_not_found(accessor, index):
    path = "/My Server/channels/general/notadate/chat.jsonl"
    with pytest.raises(FileNotFoundError):
        await stat(accessor, PathSpec(original=path, directory=path), index)


@pytest.mark.asyncio
async def test_stat_non_date_files_dir_not_found(accessor, index):
    path = "/My Server/channels/general/notadate/files"
    with pytest.raises(FileNotFoundError):
        await stat(accessor, PathSpec(original=path, directory=path), index)


@pytest.mark.asyncio
async def test_stat_not_found(accessor, index):
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            PathSpec(original="/nonexistent/path",
                     directory="/nonexistent/path"), index)
