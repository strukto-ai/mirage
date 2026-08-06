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
from mirage.core.discord.config import DiscordConfig
from mirage.core.discord.readdir import readdir
from mirage.core.discord.render import history_jsonl_bytes, member_json_bytes
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
            accessor, PathSpec(resource_path="", virtual="/", directory="/"),
            index)

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
            accessor, PathSpec(resource_path="", virtual="/", directory="/"),
            index)

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
            accessor, PathSpec(resource_path="", virtual="/", directory="/"),
            index)

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
        PathSpec(resource_path="My Server",
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
            PathSpec(resource_path="My Server/channels",
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
        PathSpec(resource_path="My Server/channels/general",
                 virtual="/My Server/channels/general",
                 directory="/My Server/channels/general"), index)

    assert len(result) >= 1
    # New layout: date directories (no extension)
    import re
    date_re = re.compile(r"^/My Server/channels/general/\d{4}-\d{2}-\d{2}$")
    assert all(date_re.match(r) for r in result)


@pytest.mark.asyncio
async def test_readdir_date_sizes_chat_jsonl(accessor, index):
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
    messages = [
        {
            "id": "1",
            "content": "hello",
            "author": {
                "username": "alice"
            }
        },
        {
            "id": "2",
            "content": "world",
            "author": {
                "username": "bob"
            }
        },
    ]
    with patch(
            "mirage.core.discord.readdir.list_messages_for_day",
            new_callable=AsyncMock,
            return_value=messages,
    ):
        await readdir(
            accessor,
            PathSpec(resource_path="My Server/channels/general/2024-01-15",
                     virtual="/My Server/channels/general/2024-01-15",
                     directory="/My Server/channels/general/2024-01-15"),
            index)

    lookup = await index.get(
        "/My Server/channels/general/2024-01-15/chat.jsonl")
    assert lookup.entry.size == len(history_jsonl_bytes(messages))


@pytest.mark.asyncio
async def test_readdir_members_sized(accessor, index):
    await index.put(
        "/My Server",
        IndexEntry(
            id="G001",
            name="My Server",
            resource_type="discord/guild",
            vfs_name="My Server",
        ),
    )
    members = [{"user": {"id": "U001", "username": "alice"}, "nick": "al"}]
    with patch(
            "mirage.core.discord.readdir.list_members",
            new_callable=AsyncMock,
            return_value=members,
    ):
        await readdir(
            accessor,
            PathSpec(resource_path="My Server/members",
                     virtual="/My Server/members",
                     directory="/My Server/members"), index)

    lookup = await index.get("/My Server/members/alice__U001.json")
    assert lookup.entry.size == len(member_json_bytes(members[0]))


@pytest.mark.asyncio
async def test_readdir_unknown_shape_raises_enoent(accessor, index):
    await index.put(
        "/My Server",
        IndexEntry(
            id="G001",
            name="My Server",
            resource_type="discord/guild",
            vfs_name="My Server",
        ),
    )
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(resource_path="My Server/nope",
                     virtual="/My Server/nope",
                     directory="/My Server/nope"), index)


@pytest.mark.asyncio
async def test_readdir_leaf_raises_enotdir(accessor, index):
    # A file is ENOTDIR, not ENOENT: callers tell "read this" from "nothing
    # here" by the errno.
    key = "My Server/channels/general/2026-06-01/chat.jsonl"
    with pytest.raises(NotADirectoryError):
        await readdir(
            accessor,
            PathSpec(resource_path=key, virtual="/" + key,
                     directory="/" + key), index)
