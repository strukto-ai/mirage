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
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.discord import DiscordAccessor
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.discord.find import find
from mirage.commands.builtin.discord.grep import grep
from mirage.commands.builtin.discord.head import head
from mirage.resource.discord.config import DiscordConfig
from mirage.types import PathSpec

GUILD_PATH = "TestGuild"
CHANNEL_PATH = "TestGuild/channels/general"
DATE_DIR_PATH = "TestGuild/channels/general/2024-01-15"
FILE_PATH = "TestGuild/channels/general/2024-01-15/chat.jsonl"
ABS_FILE = "/" + FILE_PATH
ABS_CHANNEL = "/" + CHANNEL_PATH
ABS_DATE_DIR = "/" + DATE_DIR_PATH


def _glob_result(path: str) -> list[PathSpec]:
    return [
        PathSpec(resource_path=(path).strip("/"),
                 virtual=path,
                 directory="/",
                 resolved=True)
    ]


FAKE_JSONL = (
    b'{"id":"1","content":"hello world","author":{"username":"alice"}}\n'
    b'{"id":"2","content":"goodbye moon","author":{"username":"bob"}}\n'
    b'{"id":"3","content":"hello again","author":{"username":"alice"}}\n')


def _make_glob(path: str, resolved: bool = True) -> list[PathSpec]:
    return [
        PathSpec(resource_path=(path).strip("/"),
                 virtual=path,
                 directory="/",
                 resolved=resolved)
    ]


def _run(coro):
    return asyncio.run(coro)


def _make_index() -> RAMIndexCacheStore:
    index = RAMIndexCacheStore(ttl=600)
    _run(
        index.put(
            "/" + GUILD_PATH,
            IndexEntry(id="G1",
                       name="TestGuild",
                       resource_type="discord/guild",
                       vfs_name="TestGuild")))
    _run(
        index.put(
            "/" + CHANNEL_PATH,
            IndexEntry(id="C1",
                       name="general",
                       resource_type="discord/channel",
                       vfs_name="general")))
    _run(
        index.put(
            "/" + DATE_DIR_PATH,
            IndexEntry(id="C1:2024-01-15",
                       name="2024-01-15",
                       resource_type="discord/history",
                       vfs_name="2024-01-15")))
    _run(
        index.set_dir("/" + CHANNEL_PATH, [
            ("2024-01-15",
             IndexEntry(id="C1:2024-01-15",
                        name="2024-01-15",
                        resource_type="discord/history",
                        vfs_name="2024-01-15")),
        ]))
    _run(
        index.put(
            "/" + FILE_PATH,
            IndexEntry(id="C1:2024-01-15:chat",
                       name="chat.jsonl",
                       resource_type="discord/chat_jsonl",
                       vfs_name="chat.jsonl")))
    _run(
        index.set_dir("/" + DATE_DIR_PATH, [
            ("chat.jsonl",
             IndexEntry(id="C1:2024-01-15:chat",
                        name="chat.jsonl",
                        resource_type="discord/chat_jsonl",
                        vfs_name="chat.jsonl")),
        ]))
    return index


@pytest.fixture
def accessor():
    config = DiscordConfig(token="test-token")
    return DiscordAccessor(config=config)


@pytest.fixture
def index():
    return _make_index()


async def _collect(stream) -> bytes:
    if isinstance(stream, bytes):
        return stream
    chunks = []
    async for chunk in stream:
        chunks.append(chunk)
    return b"".join(chunks)


@pytest.mark.asyncio
async def test_head(accessor):
    with (
            patch("mirage.commands.builtin.discord.head.resolve_glob",
                  new_callable=AsyncMock,
                  return_value=_glob_result(ABS_FILE)),
            patch("mirage.commands.builtin.discord.head.discord_read",
                  new_callable=AsyncMock,
                  return_value=FAKE_JSONL),
    ):
        stream, io = await head(accessor, _make_glob(ABS_FILE), n="1")
    data = await _collect(stream)
    assert b"hello world" in data
    assert b"goodbye moon" not in data


@pytest.mark.asyncio
async def test_head_default(accessor):
    with (
            patch("mirage.commands.builtin.discord.head.resolve_glob",
                  new_callable=AsyncMock,
                  return_value=_glob_result(ABS_FILE)),
            patch("mirage.commands.builtin.discord.head.discord_read",
                  new_callable=AsyncMock,
                  return_value=FAKE_JSONL),
    ):
        stream, io = await head(accessor, _make_glob(ABS_FILE))
    data = await _collect(stream)
    assert b"hello world" in data
    assert b"goodbye moon" in data
    assert b"hello again" in data


@pytest.mark.asyncio
async def test_grep(accessor):
    with (
            patch("mirage.commands.builtin.discord.grep.resolve_glob",
                  new_callable=AsyncMock,
                  return_value=_glob_result(ABS_FILE)),
            patch("mirage.commands.builtin.discord.grep.discord_read",
                  new_callable=AsyncMock,
                  return_value=FAKE_JSONL),
    ):
        stream, io = await grep(accessor, _make_glob(ABS_FILE), "hello")
    data = await _collect(stream)
    assert b"hello world" in data
    assert b"hello again" in data
    assert b"goodbye" not in data


@pytest.mark.asyncio
async def test_grep_invert(accessor):
    with (
            patch("mirage.commands.builtin.discord.grep.resolve_glob",
                  new_callable=AsyncMock,
                  return_value=_glob_result(ABS_FILE)),
            patch("mirage.commands.builtin.discord.grep.discord_read",
                  new_callable=AsyncMock,
                  return_value=FAKE_JSONL),
    ):
        stream, io = await grep(accessor,
                                _make_glob(ABS_FILE),
                                "hello",
                                v=True)
    data = await _collect(stream)
    assert b"goodbye moon" in data
    assert b"hello world" not in data


@pytest.mark.asyncio
async def test_find(accessor, index):
    with patch("mirage.commands.builtin.discord.find.resolve_glob",
               new_callable=AsyncMock,
               return_value=_glob_result(CHANNEL_PATH)):
        stream, io = await find(accessor,
                                _make_glob(ABS_CHANNEL, resolved=False),
                                index=index)
    data = await _collect(stream)
    assert b"2024-01-15" in data


@pytest.mark.asyncio
async def test_find_with_name(accessor, index):
    with patch("mirage.commands.builtin.discord.find.resolve_glob",
               new_callable=AsyncMock,
               return_value=_glob_result(CHANNEL_PATH)):
        stream, io = await find(
            accessor,
            _make_glob(ABS_CHANNEL, resolved=False),
            name="chat.jsonl",
            index=index,
        )
    data = await _collect(stream)
    assert b"chat.jsonl" in data
