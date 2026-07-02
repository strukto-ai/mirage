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

import aiohttp
import pytest

from mirage.accessor.discord import DiscordAccessor
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.discord.readdir import readdir
from mirage.resource.discord.config import DiscordConfig
from mirage.types import PathSpec


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.fixture
def accessor():
    return DiscordAccessor(config=DiscordConfig(token="t"))


async def _seed_channel(idx):
    await idx.put(
        "/G",
        IndexEntry(id="G1",
                   name="G",
                   resource_type="discord/guild",
                   vfs_name="G"),
    )
    await idx.put(
        "/G/channels/ch",
        IndexEntry(id="C1",
                   name="ch",
                   resource_type="discord/channel",
                   vfs_name="ch"),
    )


@pytest.mark.asyncio
async def test_date_dir_contents_lists_chat_and_files(accessor, index):
    fake_messages = [{
        "id":
        "100",
        "content":
        "hi",
        "attachments": [{
            "id": "A1",
            "filename": "pic.png",
            "url": "https://cdn.example/A1/pic.png",
            "proxy_url": "https://media.example/A1/pic.png",
            "content_type": "image/png",
            "size": 1234,
        }],
    }]
    await _seed_channel(index)
    with patch("mirage.core.discord.readdir.list_messages_for_day",
               new_callable=AsyncMock,
               return_value=fake_messages):
        result = await readdir(
            accessor,
            PathSpec(resource_path=("/G/channels/ch/2024-04-04").strip("/"),
                     virtual="/G/channels/ch/2024-04-04",
                     directory="/G/channels/ch/2024-04-04"),
            index,
        )
    assert "/G/channels/ch/2024-04-04/chat.jsonl" in result
    assert "/G/channels/ch/2024-04-04/files" in result


@pytest.mark.asyncio
async def test_files_dir_lists_attachments(accessor, index):
    fake_messages = [{
        "id":
        "100",
        "attachments": [{
            "id": "A1",
            "filename": "pic.png",
            "url": "https://cdn.example/A1/pic.png",
            "content_type": "image/png",
            "size": 1234,
        }],
    }]
    await _seed_channel(index)
    with patch("mirage.core.discord.readdir.list_messages_for_day",
               new_callable=AsyncMock,
               return_value=fake_messages):
        result = await readdir(
            accessor,
            PathSpec(
                resource_path=("/G/channels/ch/2024-04-04/files").strip("/"),
                virtual="/G/channels/ch/2024-04-04/files",
                directory="/G/channels/ch/2024-04-04/files"),
            index,
        )
    assert any(r.endswith("pic__A1.png") for r in result)


@pytest.mark.asyncio
async def test_fetch_day_swallows_soft_errors(accessor, index):
    await _seed_channel(index)
    err = aiohttp.ClientResponseError(
        request_info=None,  # type: ignore[arg-type]
        history=(),
        status=403,
    )
    with patch("mirage.core.discord.readdir.list_messages_for_day",
               new_callable=AsyncMock,
               side_effect=err):
        result = await readdir(
            accessor,
            PathSpec(resource_path=("/G/channels/ch/2024-04-04").strip("/"),
                     virtual="/G/channels/ch/2024-04-04",
                     directory="/G/channels/ch/2024-04-04"),
            index,
        )
    # empty day on soft error → sealed listing (no chat.jsonl/files entries)
    assert result == []


@pytest.mark.asyncio
async def test_fetch_day_propagates_hard_errors(accessor, index):
    await _seed_channel(index)
    err = aiohttp.ClientResponseError(
        request_info=None,  # type: ignore[arg-type]
        history=(),
        status=500,
    )
    with patch("mirage.core.discord.readdir.list_messages_for_day",
               new_callable=AsyncMock,
               side_effect=err):
        with pytest.raises(aiohttp.ClientResponseError):
            await readdir(
                accessor,
                PathSpec(
                    resource_path=("/G/channels/ch/2024-04-04").strip("/"),
                    virtual="/G/channels/ch/2024-04-04",
                    directory="/G/channels/ch/2024-04-04"),
                index,
            )
