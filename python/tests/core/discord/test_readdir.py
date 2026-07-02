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
    return DiscordAccessor(config=DiscordConfig(token="test-bot-token"), )


@pytest.mark.asyncio
async def test_readdir_root(accessor, index):
    guilds = [
        {
            "id": "G001",
            "name": "My Server"
        },
    ]
    with patch(
            "mirage.core.discord.readdir.list_guilds",
            new_callable=AsyncMock,
            return_value=guilds,
    ):
        result = await readdir(
            accessor,
            PathSpec(resource_path=("/").strip("/"),
                     virtual="/",
                     directory="/"), index)

    assert "/My Server__G001" in result


@pytest.mark.asyncio
async def test_readdir_root_with_slash_in_name(accessor, index):
    guilds = [
        {
            "id": "G001",
            "name": "A/B Test Server"
        },
    ]
    with patch(
            "mirage.core.discord.readdir.list_guilds",
            new_callable=AsyncMock,
            return_value=guilds,
    ):
        result = await readdir(
            accessor,
            PathSpec(resource_path=("/").strip("/"),
                     virtual="/",
                     directory="/"), index)

    assert result == ["/A∕B Test Server__G001"]


@pytest.mark.asyncio
async def test_readdir_root_with_apostrophe(accessor, index):
    guilds = [
        {
            "id": "G001",
            "name": "Zecheng's Server"
        },
    ]
    with patch(
            "mirage.core.discord.readdir.list_guilds",
            new_callable=AsyncMock,
            return_value=guilds,
    ):
        result = await readdir(
            accessor,
            PathSpec(resource_path=("/").strip("/"),
                     virtual="/",
                     directory="/"), index)

    assert "/Zecheng's Server__G001" in result


@pytest.mark.asyncio
async def test_readdir_guild(accessor, index):
    await index.put(
        "/My Server",
        IndexEntry(
            id="G001",
            name="My Server",
            resource_type="discord/guild",
            vfs_name="My Server",
        ),
    )

    result = await readdir(
        accessor,
        PathSpec(resource_path=("/My Server").strip("/"),
                 virtual="/My Server",
                 directory="/My Server"), index)

    assert result == [
        "/My Server/channels",
        "/My Server/members",
    ]


@pytest.mark.asyncio
async def test_readdir_channels(accessor, index):
    await index.put(
        "/My Server",
        IndexEntry(
            id="G001",
            name="My Server",
            resource_type="discord/guild",
            vfs_name="My Server",
        ),
    )
    channels = [
        {
            "id": "C001",
            "name": "general",
            "type": 0
        },
        {
            "id": "C002",
            "name": "random",
            "type": 0
        },
    ]
    with patch(
            "mirage.core.discord.readdir.list_channels",
            new_callable=AsyncMock,
            return_value=channels,
    ):
        result = await readdir(
            accessor,
            PathSpec(resource_path=("/My Server/channels").strip("/"),
                     virtual="/My Server/channels",
                     directory="/My Server/channels"), index)

    assert "/My Server/channels/general__C001" in result
    assert "/My Server/channels/random__C002" in result


@pytest.mark.asyncio
async def test_readdir_channel_dates(accessor, index):
    await index.put(
        "/My Server",
        IndexEntry(
            id="G001",
            name="My Server",
            resource_type="discord/guild",
            vfs_name="My Server",
        ),
    )
    await index.put(
        "/My Server/channels/general",
        IndexEntry(
            id="C001",
            name="general",
            resource_type="discord/channel",
            vfs_name="general",
        ),
    )

    result = await readdir(
        accessor,
        PathSpec(resource_path=("/My Server/channels/general").strip("/"),
                 virtual="/My Server/channels/general",
                 directory="/My Server/channels/general"), index)

    assert len(result) >= 1
    # New layout: date directories (no extension)
    import re
    date_re = re.compile(r"^/My Server/channels/general/\d{4}-\d{2}-\d{2}$")
    assert all(date_re.match(r) for r in result)
