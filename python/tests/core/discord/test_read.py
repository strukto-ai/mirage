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
from mirage.core.discord.read import read
from mirage.resource.discord.config import DiscordConfig
from mirage.types import PathSpec


@pytest.fixture
def index():
    store = RAMIndexCacheStore()
    asyncio.run(
        store.put(
            "/My Server/channels/general",
            IndexEntry(
                id="C001",
                name="general",
                resource_type="discord/channel",
                vfs_name="general",
            ),
        ))
    return store


@pytest.fixture
def accessor():
    config = DiscordConfig(token="test-bot-token")
    return DiscordAccessor(config=config)


@pytest.mark.asyncio
async def test_read_jsonl(accessor, index):
    fake_data = b'{"id":"100","content":"hello"}\n'
    with patch(
            "mirage.core.discord.read.get_history_jsonl",
            new_callable=AsyncMock,
            return_value=fake_data,
    ) as mock_hist:
        path = "/My Server/channels/general/2024-01-15/chat.jsonl"
        result = await read(
            accessor,
            PathSpec(virtual=path,
                     directory=path,
                     resource_path=path.strip("/")),
            index,
        )

    assert result == fake_data
    mock_hist.assert_called_once_with(accessor.config, "C001", "2024-01-15")


@pytest.mark.asyncio
async def test_read_not_found(accessor, index):
    with pytest.raises(FileNotFoundError):
        await read(
            accessor,
            PathSpec(resource_path=("/no/such/path").strip("/"),
                     virtual="/no/such/path",
                     directory="/no/such/path"), index)
