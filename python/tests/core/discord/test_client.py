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

import aiohttp
import pytest
import pytest_asyncio
from aioresponses import aioresponses
from yarl import URL

from mirage.accessor.discord import DiscordAccessor
from mirage.core.discord.client import (
    discord_delete,
    discord_get,
    discord_post,
    discord_put,
)
from mirage.core.discord.config import DiscordConfig

BASE = "https://discord.com/api/v10"


@pytest_asyncio.fixture
async def accessor():
    async with DiscordAccessor(DiscordConfig(token="test-bot-token")) as acc:
        yield acc


@pytest.mark.asyncio
async def test_discord_get_success(accessor):
    url = f"{BASE}/guilds/123/channels"
    with aioresponses() as m:
        m.get(url, payload=[{"id": "123", "name": "general"}])
        result = await discord_get(accessor, "/guilds/123/channels")
        sent = m.requests[("GET", URL(url))]
    assert result == [{"id": "123", "name": "general"}]
    assert len(sent) == 1
    assert sent[0].kwargs["headers"]["Authorization"] == "Bot test-bot-token"


@pytest.mark.asyncio
async def test_discord_get_rate_limited(accessor):
    url = f"{BASE}/users/@me/guilds"
    with aioresponses() as m:
        for _ in range(3):
            m.get(url, status=429, payload={"retry_after": 0.001})
        with pytest.raises(RuntimeError, match="Rate limited after 3"):
            await discord_get(accessor, "/users/@me/guilds")
        # two waits, three requests, then the error surfaces
        assert len(m.requests[("GET", URL(url))]) == 3


@pytest.mark.asyncio
async def test_discord_post_success(accessor):
    url = f"{BASE}/channels/C001/messages"
    with aioresponses() as m:
        m.post(url, payload={"id": "msg1", "content": "hello"})
        result = await discord_post(
            accessor, "/channels/C001/messages", body={"content": "hello"}
        )
        sent = m.requests[("POST", URL(url))]
    assert result["id"] == "msg1"
    assert sent[0].kwargs["json"] == {"content": "hello"}


@pytest.mark.asyncio
async def test_discord_post_rate_limited_raises_without_retrying(accessor):
    url = f"{BASE}/channels/C001/messages"
    with aioresponses() as m:
        m.post(url, status=429, payload={"retry_after": 2.5})
        with pytest.raises(RuntimeError, match="retry after 2.5s"):
            await discord_post(accessor, "/channels/C001/messages", body={})
        assert len(m.requests[("POST", URL(url))]) == 1


@pytest.mark.asyncio
async def test_discord_get_error_keeps_the_aiohttp_type(accessor):
    # readdir classifies on ClientResponseError.status, so the migration
    # onto core/api must keep raising the aiohttp type for plain errors.
    url = f"{BASE}/guilds/999"
    with aioresponses() as m:
        m.get(url, status=404, payload={"message": "Unknown Guild"})
        with pytest.raises(aiohttp.ClientResponseError) as exc:
            await discord_get(accessor, "/guilds/999")
    assert exc.value.status == 404


@pytest.mark.asyncio
async def test_discord_put_and_delete_return_nothing(accessor):
    put_url = f"{BASE}/channels/C001/messages/m1/reactions/%F0%9F%91%8D/@me"
    delete_url = f"{BASE}/channels/C001/messages/m1"
    with aioresponses() as m:
        m.put(put_url, status=204)
        m.delete(delete_url, status=200, payload={"id": "m1"})
        assert (
            await discord_put(
                accessor,
                "/channels/C001/messages/m1/reactions/%F0%9F%91%8D/@me",
            )
            is None
        )
        assert (
            await discord_delete(accessor, "/channels/C001/messages/m1")
            is None
        )
